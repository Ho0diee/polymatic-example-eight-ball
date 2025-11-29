import { Dataset, Driver, Memo, Middleware } from "polymatic";
import { World, Circle, Polygon, Body, Settings } from "planck";

import { CueStick, Ball, Pocket, Rail, Table, type BilliardContext } from "../eight-ball/BilliardContext";
import { type ClientBilliardContext } from "./ClientContext";

// Import the physics lookup table (unit vectors for ball directions)
import PHYSICS_LOOKUP_JSON from "../../physics-lookup.json";

const SVG_NS = "http://www.w3.org/2000/svg";

const STROKE_WIDTH = 0.006 / 2;

// ============================================
// PHYSICS LOOKUP TABLE
// Pre-computed unit vectors from Planck.js simulation
// Key: "cutAngle_power" -> { tx, ty, cx, cy } unit vectors
// tx, ty = target ball direction (when shooting along +X axis)
// cx, cy = cue ball direction after collision
// ============================================
const PHYSICS_LOOKUP_TABLE: { [key: string]: { tx: number; ty: number; cx: number; cy: number } } = PHYSICS_LOOKUP_JSON;

// Helper function to lookup physics prediction
// Returns unit vectors for target and cue ball directions (in local space, shooting along +X)
function lookupPhysicsPrediction(cutAngleDeg: number, power: number): { tx: number; ty: number; cx: number; cy: number } | null {
  // Round angle to nearest degree (table has every degree from -89 to 89)
  const roundedAngle = Math.round(cutAngleDeg);
  
  // Clamp to valid range
  if (roundedAngle < -89 || roundedAngle > 89) {
    return null;
  }
  
  // Find closest power from available powers
  const powers = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.25, 1.5, 1.75, 2];
  let closestPower = powers.reduce((a, b) => Math.abs(b - power) < Math.abs(a - power) ? b : a);
  
  const key = `${roundedAngle}_${closestPower}`;
  return PHYSICS_LOOKUP_TABLE[key] || null;
}

// Quaternion helper
class Quaternion {
  w: number;
  x: number;
  y: number;
  z: number;

  constructor(w: number = 1, x: number = 0, y: number = 0, z: number = 0) {
    this.w = w;
    this.x = x;
    this.y = y;
    this.z = z;
  }

  static fromAxisAngle(axis: { x: number; y: number; z: number }, angle: number) {
    const halfAngle = angle / 2;
    const s = Math.sin(halfAngle);
    return new Quaternion(Math.cos(halfAngle), axis.x * s, axis.y * s, axis.z * s);
  }

  multiply(q: Quaternion) {
    const w = this.w * q.w - this.x * q.x - this.y * q.y - this.z * q.z;
    const x = this.w * q.x + this.x * q.w + this.y * q.z - this.z * q.y;
    const y = this.w * q.y - this.x * q.z + this.y * q.w + this.z * q.x;
    const z = this.w * q.z + this.x * q.y - this.y * q.x + this.z * q.w;
    return new Quaternion(w, x, y, z);
  }

  normalize() {
    const len = Math.sqrt(this.w * this.w + this.x * this.x + this.y * this.y + this.z * this.z);
    if (len === 0) return this;
    this.w /= len;
    this.x /= len;
    this.y /= len;
    this.z /= len;
    return this;
  }

  conjugate() {
    return new Quaternion(this.w, -this.x, -this.y, -this.z);
  }

  rotateVector(v: { x: number; y: number; z: number }) {
    // p' = q * p * q^-1
    const qv = new Quaternion(0, v.x, v.y, v.z);
    const qInv = this.conjugate();
    const qResult = this.multiply(qv).multiply(qInv);
    return { x: qResult.x, y: qResult.y, z: qResult.z };
  }
}

/**
 * Implements rendering and collecting user-input
 */
export class Terminal extends Middleware<ClientBilliardContext> {
  container: SVGGElement;

  scorecardGroup: SVGGElement;
  ballsGroup: SVGGElement;
  tableGroup: SVGGElement;
  cueGroup: SVGGElement;
  frameGroup: SVGGElement;
  headstringGroup: SVGGElement;
  placementBallGroup: SVGGElement;

  constructor() {
    super();
    this.on("activate", this.handleActivate);
    this.on("deactivate", this.handleDeactivate);
    this.on("frame-loop", this.handleFrameLoop);
    this.on("main-start", this.handleStart);
    this.on("ball-in-hand", this.handleBallInHand);

    this.dataset.addDriver(this.tableDriver);
    this.dataset.addDriver(this.railDriver);
    this.dataset.addDriver(this.pocketDriver);

    this.dataset.addDriver(this.ballDriver);

    this.dataset.addDriver(this.cueDriver);

    this.scorecardGroup = document.createElementNS(SVG_NS, "g");
    this.ballsGroup = document.createElementNS(SVG_NS, "g");
    this.tableGroup = document.createElementNS(SVG_NS, "g");
    this.cueGroup = document.createElementNS(SVG_NS, "g");
    this.frameGroup = document.createElementNS(SVG_NS, "g");
    this.headstringGroup = document.createElementNS(SVG_NS, "g");
    this.placementBallGroup = document.createElementNS(SVG_NS, "g");

    this.container = document.createElementNS(SVG_NS, "g");
    this.container.classList.add("billiards");

    // Order matters for z-index
    this.container.appendChild(this.frameGroup); // outer wood frame behind everything
    this.container.appendChild(this.tableGroup);
    this.container.appendChild(this.headstringGroup); // Headstring line (when ball in hand)
    this.container.appendChild(this.ballsGroup);
    this.container.appendChild(this.placementBallGroup); // Placement ball (when ball in hand)
    this.container.appendChild(this.cueGroup); // Cue on top of balls
    this.container.appendChild(this.scorecardGroup);
  }

  // Dev prediction toggle
  showDevPrediction = false;
  
  // Hacker mode - activated by typing "opopopopop"
  hackerMode = false;
  hackerModePlayer: string | null = null; // Track which player activated hacker mode
  hackerModeBuffer = '';
  hackerModeCode = 'opopopopop';
  pocketableShots: { ballKey: string; aimDir: { x: number; y: number }; pocketPos: { x: number; y: number } }[] = [];
  currentPocketShotIndex = -1;
  
  // Physics simulation cache for predictions
  predictionCache: {
    cueBallEnd: { x: number; y: number } | null;
    targetBallEnd: { x: number; y: number } | null;
    targetBallKey: string | null;
    targetBallDir: { x: number; y: number } | null;
    targetBallSpeed: number; // Speed of target ball after hit
    cueBallDirAfterHit: { x: number; y: number } | null;
    cueBallSpeedAfterHit: number; // Speed of cue ball after hit
    hitPoint: { x: number; y: number } | null;
    targetBallPos: { x: number; y: number } | null;
    cueBallPath: { x: number; y: number }[];
    targetBallPath: { x: number; y: number }[];
    willPocket: boolean;
    pocketedBallKey: string | null;
    firstWallBounce: { point: { x: number; y: number }; dirAfter: { x: number; y: number } } | null;
    lastShotDirX: number;
    lastShotDirY: number;
    lastCuePosX: number;
    lastCuePosY: number;
  } = {
    cueBallEnd: null, targetBallEnd: null, targetBallKey: null, targetBallDir: null,
    targetBallSpeed: 0,
    cueBallDirAfterHit: null,
    cueBallSpeedAfterHit: 0,
    hitPoint: null, targetBallPos: null, cueBallPath: [], targetBallPath: [],
    willPocket: false, pocketedBallKey: null, firstWallBounce: null,
    lastShotDirX: 0, lastShotDirY: 0, lastCuePosX: 0, lastCuePosY: 0
  };
  
  // Simulate shot using physics engine to get accurate predictions
  simulateShot(shotDir: { x: number; y: number }, power: number): { 
    cueBallEnd: { x: number; y: number } | null;
    targetBallEnd: { x: number; y: number } | null;
    targetBallKey: string | null;
    targetBallDir: { x: number; y: number } | null;
    targetBallSpeed: number;
    cueBallDirAfterHit: { x: number; y: number } | null;
    cueBallSpeedAfterHit: number;
    hitPoint: { x: number; y: number } | null;
    targetBallPos: { x: number; y: number } | null;
    cueBallPath: { x: number; y: number }[];
    targetBallPath: { x: number; y: number }[];
    willPocket: boolean;
    pocketedBallKey: string | null;
    firstWallBounce: { point: { x: number; y: number }; dirAfter: { x: number; y: number } } | null;
  } {
    if (!this.context.balls || !this.context.rails || !this.context.table || !this.context.pockets) {
      return { cueBallEnd: null, targetBallEnd: null, targetBallKey: null, targetBallDir: null, targetBallSpeed: 0, cueBallDirAfterHit: null, cueBallSpeedAfterHit: 0, hitPoint: null, targetBallPos: null, cueBallPath: [], targetBallPath: [], willPocket: false, pocketedBallKey: null, firstWallBounce: null };
    }
    
    const cueBall = this.context.balls.find(b => b.color === 'white');
    if (!cueBall) {
      return { cueBallEnd: null, targetBallEnd: null, targetBallKey: null, targetBallDir: null, targetBallSpeed: 0, cueBallDirAfterHit: null, cueBallSpeedAfterHit: 0, hitPoint: null, targetBallPos: null, cueBallPath: [], targetBallPath: [], willPocket: false, pocketedBallKey: null, firstWallBounce: null };
    }
    
    // Create a temporary physics world (matching Physics.ts setup)
    Settings.velocityThreshold = 0;
    const world = new World();
    
    // Physics constants (matching Physics.ts)
    const LINEAR_DAMPING = 2.2;
    const ANGULAR_DAMPING = 1.5;
    const BALL_FRICTION = 0.1;
    const BALL_RESTITUTION = 0.99;
    const RAIL_FRICTION = 0.1;
    const RAIL_RESTITUTION = 0.9;
    const MAX_FORCE = 0.06;
    
    // Track pocketed balls via collision detection
    const pocketedBalls = new Set<string>();
    const pockets = this.context.pockets;
    
    // Create pocket bodies (IMPORTANT: like Physics.ts, pockets are sensors)
    const pocketBodies = new Map<string, Body>();
    for (const pocket of pockets) {
      const body = world.createBody({
        type: 'static',
        position: { x: pocket.position.x, y: pocket.position.y },
        userData: { type: 'pocket', key: pocket.key },
      });
      body.createFixture({
        shape: new Circle(pocket.radius),
        isSensor: true, // Pockets don't apply force, just detect
        userData: { type: 'pocket', key: pocket.key },
      });
      pocketBodies.set(pocket.key, body);
    }
    
    // Create ball bodies
    const ballBodies = new Map<string, Body>();
    for (const ball of this.context.balls) {
      const body = world.createBody({
        type: 'dynamic',
        bullet: true,
        position: { x: ball.position.x, y: ball.position.y },
        linearDamping: LINEAR_DAMPING,
        angularDamping: ANGULAR_DAMPING,
        userData: { type: 'ball', key: ball.key },
      });
      body.createFixture({
        shape: new Circle(ball.radius),
        friction: BALL_FRICTION,
        restitution: BALL_RESTITUTION,
        density: 1,
        userData: { type: 'ball', key: ball.key },
      });
      ballBodies.set(ball.key, body);
    }
    
    // Create rail bodies (matching Physics.ts exactly)
    for (const rail of this.context.rails) {
      const body = world.createBody({ type: 'static' });
      body.createFixture({
        shape: new Polygon(rail.vertices),
        friction: RAIL_FRICTION,
        restitution: RAIL_RESTITUTION,
      });
    }
    
    // Set up pocket collision detection (like Physics.ts)
    world.on('begin-contact', (contact) => {
      const fA = contact.getFixtureA();
      const fB = contact.getFixtureB();
      const dataA = fA.getUserData() as { type: string; key: string } | null;
      const dataB = fB.getUserData() as { type: string; key: string } | null;
      
      if (!dataA || !dataB) return;
      
      const ball = dataA?.type === 'ball' ? dataA : dataB?.type === 'ball' ? dataB : null;
      const pocket = dataA?.type === 'pocket' ? dataA : dataB?.type === 'pocket' ? dataB : null;
      
      if (ball && pocket) {
        pocketedBalls.add(ball.key);
      }
    });
    
    // Apply impulse to cue ball
    const cueBallBody = ballBodies.get(cueBall.key);
    if (!cueBallBody) {
      return { cueBallEnd: null, targetBallEnd: null, targetBallKey: null, targetBallDir: null, targetBallSpeed: 0, cueBallDirAfterHit: null, cueBallSpeedAfterHit: 0, hitPoint: null, targetBallPos: null, cueBallPath: [], targetBallPath: [], willPocket: false, pocketedBallKey: null, firstWallBounce: null };
    }
    
    const impulse = power * MAX_FORCE;
    cueBallBody.applyLinearImpulse(
      { x: shotDir.x * impulse, y: shotDir.y * impulse },
      cueBallBody.getPosition()
    );
    
    // Track cue ball path and first ball collision
    let firstHitBallKey: string | null = null;
    let targetBallDir: { x: number; y: number } | null = null;
    let targetBallSpeed = 0;
    let hitPoint: { x: number; y: number } | null = null;
    let targetBallPos: { x: number; y: number } | null = null;
    let cueBallDirAfterHit: { x: number; y: number } | null = null;
    let cueBallSpeedAfterHit = 0;
    let firstWallBounce: { point: { x: number; y: number }; dirAfter: { x: number; y: number } } | null = null;
    const cueBallPath: { x: number; y: number }[] = [];
    
    // Record starting position
    const startPos = cueBallBody.getPosition();
    cueBallPath.push({ x: startPos.x, y: startPos.y });
    let lastRecordedPos = { x: startPos.x, y: startPos.y };
    
    // Track previous velocity direction to detect wall bounces
    let prevVelDir = { x: shotDir.x, y: shotDir.y };
    
    // Step simulation until cue ball hits another ball or stops
    const timeStep = 1 / 120;
    const maxSteps = 360; // 3 seconds - enough for bounces
    
    for (let step = 0; step < maxSteps; step++) {
      world.step(timeStep);
      
      // Record cue ball position periodically (every 6 frames = 20 points per second)
      const cuePos = cueBallBody.getPosition();
      const cueVel = cueBallBody.getLinearVelocity();
      const cueSpeed = Math.sqrt(cueVel.x * cueVel.x + cueVel.y * cueVel.y);
      
      // Detect wall bounce (significant direction change) - only track first one
      if (!firstWallBounce && cueSpeed > 0.01) {
        const currentDir = { x: cueVel.x / cueSpeed, y: cueVel.y / cueSpeed };
        const dotProduct = prevVelDir.x * currentDir.x + prevVelDir.y * currentDir.y;
        // If dot product < 0.7, direction changed significantly (bounce)
        if (dotProduct < 0.7) {
          firstWallBounce = {
            point: { x: cuePos.x, y: cuePos.y },
            dirAfter: { x: currentDir.x, y: currentDir.y }
          };
        }
        prevVelDir = currentDir;
      }
      
      const distFromLast = Math.sqrt(
        (cuePos.x - lastRecordedPos.x) ** 2 + 
        (cuePos.y - lastRecordedPos.y) ** 2
      );
      if (distFromLast > 0.02) { // Record if moved more than 2cm
        cueBallPath.push({ x: cuePos.x, y: cuePos.y });
        lastRecordedPos = { x: cuePos.x, y: cuePos.y };
      }

      // Check if any ball started moving (means cue ball hit it)
      for (const [key, body] of ballBodies) {
        if (key === cueBall.key) continue;
        const vel = body.getLinearVelocity();
        const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
        if (speed > 0.001) {
          // Found the ball that got hit - capture everything RIGHT NOW
          firstHitBallKey = key;
          targetBallDir = { x: vel.x / speed, y: vel.y / speed };
          targetBallSpeed = speed; // Capture target ball speed
          hitPoint = { x: cuePos.x, y: cuePos.y };
          const targetPos = body.getPosition();
          targetBallPos = { x: targetPos.x, y: targetPos.y };
          // Capture cue ball direction and speed after hit
          cueBallSpeedAfterHit = cueSpeed;
          if (cueSpeed > 0.01) {
            cueBallDirAfterHit = { x: cueVel.x / cueSpeed, y: cueVel.y / cueSpeed };
          }
          // Add final position to path
          cueBallPath.push({ x: cuePos.x, y: cuePos.y });
          break;
        }
      }
      
      // If we found a hit ball, stop
      if (firstHitBallKey) break;
      
      // Also stop if cue ball has stopped moving
      if (cueSpeed < 0.01) break;
    }
    
    // Now track the target ball's path and check for pocketing (using collision detection)
    const targetBallPath: { x: number; y: number }[] = [];
    let willPocket = false;
    let pocketedBallKey: string | null = null;
    
    if (firstHitBallKey && targetBallPos) {
      const targetBody = ballBodies.get(firstHitBallKey);
      if (targetBody) {
        targetBallPath.push({ x: targetBallPos.x, y: targetBallPos.y });
        let lastTargetPos = { x: targetBallPos.x, y: targetBallPos.y };
        
        // Continue simulation to track target ball and detect pocketing via physics
        for (let step = 0; step < 5 * 120; step++) {
          world.step(timeStep);
          
          const pos = targetBody.getPosition();
          const distFromLast = Math.sqrt(
            (pos.x - lastTargetPos.x) ** 2 + 
            (pos.y - lastTargetPos.y) ** 2
          );
          if (distFromLast > 0.02) {
            targetBallPath.push({ x: pos.x, y: pos.y });
            lastTargetPos = { x: pos.x, y: pos.y };
          }
          
          // Check if target ball was pocketed (via collision callback)
          if (pocketedBalls.has(firstHitBallKey)) {
            willPocket = true;
            pocketedBallKey = firstHitBallKey;
            // Find which pocket it went into
            for (const pocket of pockets) {
              const dx = pos.x - pocket.position.x;
              const dy = pos.y - pocket.position.y;
              const dist = Math.sqrt(dx * dx + dy * dy);
              if (dist < pocket.radius * 1.5) {
                targetBallPath.push({ x: pocket.position.x, y: pocket.position.y });
                break;
              }
            }
            break;
          }
          
          // Stop if ball stopped
          const vel = targetBody.getLinearVelocity();
          const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
          if (speed < 0.01) {
            targetBallPath.push({ x: pos.x, y: pos.y });
            break;
          }
        }
      }
    }
    
    const cueBallPos = cueBallBody.getPosition();
    const cueBallEnd = { x: cueBallPos.x, y: cueBallPos.y };
    
    let targetBallEnd: { x: number; y: number } | null = null;
    
    if (firstHitBallKey) {
      const targetBody = ballBodies.get(firstHitBallKey);
      if (targetBody) {
        const pos = targetBody.getPosition();
        targetBallEnd = { x: pos.x, y: pos.y };
      }
    }
    
    return { cueBallEnd, targetBallEnd, targetBallKey: firstHitBallKey, targetBallDir, targetBallSpeed, cueBallDirAfterHit, cueBallSpeedAfterHit, hitPoint, targetBallPos, cueBallPath, targetBallPath, willPocket, pocketedBallKey, firstWallBounce };
  }
  
  // Dev prediction tracking - store predictions to compare after shot
  lastPrediction: {
    cueBallEnd: { x: number; y: number } | null;
    targetBallEnd: { x: number; y: number } | null;
    targetBallKey: string | null;
    timestamp: number;
    locked: boolean; // When true, don't update prediction (shot in progress)
    power: number; // Power at time of prediction
    hitType: string; // 'ball' or 'wall' or 'none'
    predictedTargetDir: { x: number; y: number } | null; // Corrected direction vector
    rawTargetDir: { x: number; y: number } | null; // Geometric normal vector
    hitBallPos: { x: number; y: number } | null; // Predicted collision point
    cutAngle: number; // Angle between shot direction and impact normal (degrees)
    shotDir: { x: number; y: number } | null; // Shot direction vector
    // Guide prediction (what was visually shown to user)
    guideHitType: string; // 'ball' or 'wall' from the visual guide
    guideHitBallKey: string | null; // Which ball the guide said we'd hit
    // Actual first contact (tracked during real gameplay)
    actualFirstHitType: string; // 'ball' or 'wall' - what actually happened first
    actualFirstHitBallKey: string | null; // Which ball was actually hit first (if any)
  } = { 
    cueBallEnd: null, targetBallEnd: null, targetBallKey: null, 
    timestamp: 0, locked: false, power: 0, hitType: 'none',
    predictedTargetDir: null, rawTargetDir: null, hitBallPos: null, cutAngle: 0, shotDir: null,
    guideHitType: 'none', guideHitBallKey: null,
    actualFirstHitType: 'none', actualFirstHitBallKey: null
  };

  // Track ball positions at shot start to detect first movement
  ballPositionsAtShotStart: Map<string, { x: number; y: number }> = new Map();
  firstContactDetected: boolean = false;

  // Monitoring state
  shotMonitor: {
    active: boolean;
    targetBallStartPos: { x: number; y: number } | null;
    targetBallMoved: boolean;
    rafId: number | null;
  } = { active: false, targetBallStartPos: null, targetBallMoved: false, rafId: null };

  handleActivate() {
    const svg = document.getElementById("polymatic-eight-ball");
    if (svg && svg instanceof SVGSVGElement) {
      // Add gradient definitions
      this.addSvgDefs(svg);
      
      svg.appendChild(this.container);
      this.container.parentElement?.addEventListener("pointerdown", this.handlePointerDown);
      this.container.parentElement?.addEventListener("pointermove", this.handlePointerMove);
      this.container.parentElement?.addEventListener("pointerup", this.handlePointerUp);
      
      this.setupPowerControl();
      this.setupDevPredictionButton();
      this.setupHackerMode();
      
      // Listen for shot events to lock/unlock prediction
      // Use cue-shot to get the actual shot vector for accurate prediction
      this.on("cue-shot", this.handleShotStartPrediction);
      this.on("shot-end", this.handleShotEndPrediction);

      window.addEventListener("resize", this.handleWindowResize);
      window.addEventListener("orientationchange", this.handleWindowResize);
      this.handleWindowResize();
    } else {
      console.error("Container SVG element not found");
    }
  }
  
  setupHackerMode() {
    // Listen for key presses to detect the secret code
    document.addEventListener('keydown', (e) => {
      // Check if it's the hacker mode player's turn
      // Hacker mode only works when it's the turn of the player who activated it
      const currentTurn = this.context.turn?.current;
      const isHackerPlayer = this.hackerMode && this.hackerModePlayer === currentTurn;
      
      // Handle 'o' key for auto-shoot at max power (only in hacker mode for the activating player)
      if (isHackerPlayer && e.key.toLowerCase() === 'o') {
        // Fire shot at max power with current aim direction
        if (!this.context.shotInProgress && !this.context.ballInHand) {
          this.emit("user-power-release", 1.0);
        }
        return;
      }
      
      // Handle 'p' key for pocket shot finder (only in hacker mode for the activating player)
      if (isHackerPlayer && e.key.toLowerCase() === 'p') {
        this.findNextPocketShot();
        return;
      }
      
      this.hackerModeBuffer += e.key.toLowerCase();
      // Keep buffer limited
      if (this.hackerModeBuffer.length > 20) {
        this.hackerModeBuffer = this.hackerModeBuffer.slice(-20);
      }
      // Check for code
      if (this.hackerModeBuffer.includes(this.hackerModeCode)) {
        this.hackerMode = !this.hackerMode;
        // Track which player's turn it was when they activated hacker mode
        // Use context.turn.current so it works for both offline and online
        this.hackerModePlayer = this.hackerMode ? (this.context.turn?.current ?? null) : null;
        this.hackerModeBuffer = '';
        // Reset pocket shots when toggling
        this.pocketableShots = [];
        this.currentPocketShotIndex = -1;
        
        // Show activation message with player info
        const playerNum = this.hackerModePlayer !== null ? (parseInt(this.hackerModePlayer) + 1) : null;
        const playerInfo = playerNum !== null ? ` (Player ${playerNum})` : '';
        const msg = document.createElement('div');
        msg.style.cssText = `
          position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
          background: ${this.hackerMode ? 'rgba(0, 255, 0, 0.9)' : 'rgba(255, 0, 0, 0.9)'};
          color: ${this.hackerMode ? '#000' : '#fff'}; padding: 20px 40px;
          font-family: 'Courier New', monospace; font-size: 24px; font-weight: bold;
          border-radius: 10px; z-index: 10000;
          box-shadow: 0 0 30px ${this.hackerMode ? '#0f0' : '#f00'};
          text-transform: uppercase; letter-spacing: 3px;
        `;
        msg.textContent = this.hackerMode ? `?? HACKER MODE ON${playerInfo} (P=pocket, O=shoot) ??` : '? HACKER MODE OFF ?';
        document.body.appendChild(msg);
        setTimeout(() => msg.remove(), 1500);
      }
    });
  }
  
  findNextPocketShot() {
    // Scan all possible shots (360 degrees) and find ones that pocket a ball at MAX POWER
    if (this.pocketableShots.length === 0 || this.currentPocketShotIndex < 0) {
      this.scanForPocketShots();
    }
    
    if (this.pocketableShots.length === 0) {
      // No pocketable shots found - show message
      const msg = document.createElement('div');
      msg.style.cssText = `
        position: fixed; top: 20%; left: 50%; transform: translate(-50%, -50%);
        background: rgba(255, 100, 0, 0.9); color: #fff; padding: 15px 30px;
        font-family: 'Courier New', monospace; font-size: 18px; font-weight: bold;
        border-radius: 8px; z-index: 10000;
        box-shadow: 0 0 20px #f80;
      `;
      msg.textContent = '? No pocketable shots found!';
      document.body.appendChild(msg);
      setTimeout(() => msg.remove(), 1000);
      return;
    }
    
    // Cycle to next shot
    this.currentPocketShotIndex = (this.currentPocketShotIndex + 1) % this.pocketableShots.length;
    const shot = this.pocketableShots[this.currentPocketShotIndex];
    
    // Aim at this shot by emitting a pointer move event
    const cueBall = this.context.balls?.find(b => b.color === 'white');
    if (cueBall) {
      // CueShot works like this:
      // - aimVector = -(mousePos - ballPos) = ballPos - mousePos
      // - shot direction = -aimVector = mousePos - ballPos
      // So mouse should be in the DIRECTION we want the ball to go
      const aimPoint = {
        x: cueBall.position.x + shot.aimDir.x * 2,
        y: cueBall.position.y + shot.aimDir.y * 2
      };
      this.emit('user-pointer-move', aimPoint);
      
      // Show which shot is selected
      const msg = document.createElement('div');
      msg.style.cssText = `
        position: fixed; top: 10%; left: 50%; transform: translate(-50%, -50%);
        background: rgba(0, 200, 0, 0.9); color: #fff; padding: 10px 20px;
        font-family: 'Courier New', monospace; font-size: 16px; font-weight: bold;
        border-radius: 8px; z-index: 10000;
        box-shadow: 0 0 15px #0f0;
      `;
      msg.textContent = `?? Shot ${this.currentPocketShotIndex + 1}/${this.pocketableShots.length}: ${shot.ballKey}`;
      document.body.appendChild(msg);
      setTimeout(() => msg.remove(), 800);
    }
  }
  
  scanForPocketShots() {
    this.pocketableShots = [];
    this.currentPocketShotIndex = -1;
    
    if (!this.context.balls || !this.context.pockets) return;
    
    const cueBall = this.context.balls.find(b => b.color === 'white');
    if (!cueBall) return;
    
    // Scan angles in 1 degree increments around full circle
    const angleStep = 1 * Math.PI / 180; // 1 degree in radians
    const foundShots = new Set<string>(); // Track unique balls that can be pocketed
    
    for (let angle = 0; angle < 2 * Math.PI; angle += angleStep) {
      const aimDir = {
        x: Math.cos(angle),
        y: Math.sin(angle)
      };
      
      // Simulate with MAX POWER (1.0)
      const result = this.simulateShot(aimDir, 1.0);
      
      if (result.willPocket && result.pocketedBallKey) {
        const key = result.pocketedBallKey;
        
        // Only add if we haven't found this ball being pocketed yet
        if (!foundShots.has(key)) {
          foundShots.add(key);
          this.pocketableShots.push({
            ballKey: result.pocketedBallKey,
            aimDir: { x: aimDir.x, y: aimDir.y },
            pocketPos: { x: 0, y: 0 }
          });
        }
      }
    }
  }
  
  handleShotStartPrediction = (data?: { ball?: { position: { x: number; y: number }; key: string }; shot?: { x: number; y: number } }) => {
    // Store all ball positions at shot start to detect first contact
    this.ballPositionsAtShotStart.clear();
    this.firstContactDetected = false;
    this.lastPrediction.actualFirstHitType = 'wall'; // Default to wall if no ball moves
    this.lastPrediction.actualFirstHitBallKey = null;
    
    if (this.context.balls) {
      for (const ball of this.context.balls) {
        if (ball.color !== 'white') { // Don't track cue ball
          this.ballPositionsAtShotStart.set(ball.key, { x: ball.position.x, y: ball.position.y });
        }
      }
    }
    
    // Start monitoring for first ball contact
    this.startFirstContactMonitor();
    
    // Run a FRESH simulation with the ACTUAL shot parameters
    if (data?.shot && data?.ball) {
      const shotMag = Math.sqrt(data.shot.x ** 2 + data.shot.y ** 2);
      if (shotMag > 0.0001) {
        const shotDir = { x: data.shot.x / shotMag, y: data.shot.y / shotMag };
        // Power = force / MAX_FORCE where MAX_FORCE = 0.06
        const power = shotMag / 0.06;
        
        // Log ball positions for debugging
        console.log('=== SHOT START DEBUG ===');
        console.log('Cue ball position from event:', data.ball.position);
        const cueBallFromContext = this.context.balls?.find(b => b.color === 'white');
        console.log('Cue ball position from context:', cueBallFromContext?.position);
        console.log('Shot direction:', shotDir);
        console.log('Shot impulse:', data.shot);
        console.log('All balls:', this.context.balls?.map(b => ({ key: b.key, color: b.color, pos: b.position })));
        
        // Run simulation with actual shot parameters
        const simResult = this.simulateShot(shotDir, power);
        
        // Update lastPrediction with fresh simulation results
        this.lastPrediction.cueBallEnd = simResult.cueBallEnd;
        this.lastPrediction.targetBallEnd = simResult.targetBallEnd;
        this.lastPrediction.targetBallKey = simResult.targetBallKey;
        this.lastPrediction.power = power;
        this.lastPrediction.hitType = simResult.targetBallKey ? 'ball' : 'wall';
        
        console.log('Simulation result:', {
          targetBallKey: simResult.targetBallKey,
          cueBallEnd: simResult.cueBallEnd,
          targetBallEnd: simResult.targetBallEnd,
          willPocket: simResult.willPocket,
          pocketedBallKey: simResult.pocketedBallKey
        });
        console.log('=== END DEBUG ===');
      }
    }
    
    // Lock the prediction so it doesn't get overwritten while shot is in progress
    this.lastPrediction.locked = true;
    this.lastPrediction.timestamp = Date.now();
    
    // Start monitoring for direction accuracy
    if (this.showDevPrediction && this.lastPrediction.targetBallKey) {
      this.startShotMonitor();
    }
  };
  
  // Monitor to detect which ball is hit first during actual gameplay
  firstContactMonitorId: number | null = null;
  
  startFirstContactMonitor = () => {
    if (this.firstContactMonitorId) {
      cancelAnimationFrame(this.firstContactMonitorId);
    }
    
    const checkForFirstContact = () => {
      if (this.firstContactDetected || !this.context.shotInProgress) {
        return; // Stop monitoring
      }
      
      // Check if any non-cue ball has moved from its starting position
      for (const [ballKey, startPos] of this.ballPositionsAtShotStart) {
        const ball = this.context.balls?.find(b => b.key === ballKey);
        if (ball) {
          const dx = ball.position.x - startPos.x;
          const dy = ball.position.y - startPos.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          
          // If ball moved more than 1mm, it was hit
          if (dist > 0.001) {
            this.firstContactDetected = true;
            this.lastPrediction.actualFirstHitType = 'ball';
            this.lastPrediction.actualFirstHitBallKey = ballKey;
            console.log(`[FIRST CONTACT] Ball ${ballKey} moved first (${(dist * 1000).toFixed(1)}mm)`);
            return; // Stop monitoring
          }
        }
      }
      
      // Continue monitoring
      this.firstContactMonitorId = requestAnimationFrame(checkForFirstContact);
    };
    
    this.firstContactMonitorId = requestAnimationFrame(checkForFirstContact);
  };
  
  startShotMonitor = () => {
    this.shotMonitor.active = true;
    this.shotMonitor.targetBallMoved = false;
    this.shotMonitor.targetBallStartPos = null;
    
    const monitorLoop = () => {
      if (!this.shotMonitor.active) return;
      
      const targetKey = this.lastPrediction.targetBallKey;
      if (!targetKey) return;
      
      const targetBall = this.context.balls?.find(b => b.key === targetKey);
      if (!targetBall) return;
      
      // Check if ball has started moving
      if (!this.shotMonitor.targetBallMoved) {
        // We need to detect when it starts moving.
        // But we don't have velocity here. We can check if position changed from prediction time.
        // Actually, we should store the position at shot start.
        if (!this.shotMonitor.targetBallStartPos) {
           this.shotMonitor.targetBallStartPos = { x: targetBall.position.x, y: targetBall.position.y };
        } else {
           const dx = targetBall.position.x - this.shotMonitor.targetBallStartPos.x;
           const dy = targetBall.position.y - this.shotMonitor.targetBallStartPos.y;
           const dist = Math.sqrt(dx * dx + dy * dy);
           
           // If moved > 1mm, it has been hit
           if (dist > 0.001) {
             this.shotMonitor.targetBallMoved = true;
             // Reset start pos to current pos (collision point)
             this.shotMonitor.targetBallStartPos = { x: targetBall.position.x, y: targetBall.position.y };
           }
        }
      } else {
        // Ball is moving. Wait until it moves enough to get a vector (e.g. 5cm)
        if (this.shotMonitor.targetBallStartPos) {
           const dx = targetBall.position.x - this.shotMonitor.targetBallStartPos.x;
           const dy = targetBall.position.y - this.shotMonitor.targetBallStartPos.y;
           const dist = Math.sqrt(dx * dx + dy * dy);
           
           // Reduce threshold to 2cm to avoid rail interference
           if (dist > 0.02) {
             // Calculate actual direction
             const actualDirX = dx / dist;
             const actualDirY = dy / dist;
             
             // Compare with predicted
             if (this.lastPrediction.predictedTargetDir) {
               const predX = this.lastPrediction.predictedTargetDir.x;
               const predY = this.lastPrediction.predictedTargetDir.y;
               
               // Dot product -> angle
               const dot = actualDirX * predX + actualDirY * predY;
               const angleRad = Math.acos(Math.min(1, Math.max(-1, dot)));
               const angleDeg = angleRad * (180 / Math.PI);
               
               // Calculate raw angles for debugging
               const actualAngle = Math.atan2(actualDirY, actualDirX) * (180 / Math.PI);
               const predAngle = Math.atan2(predY, predX) * (180 / Math.PI);
               
               let rawAngle = 0;
               let shotAngle = 0;
               if (this.lastPrediction.rawTargetDir) {
                 rawAngle = Math.atan2(this.lastPrediction.rawTargetDir.y, this.lastPrediction.rawTargetDir.x) * (180 / Math.PI);
               }
               if (this.lastPrediction.shotDir) {
                 shotAngle = Math.atan2(this.lastPrediction.shotDir.y, this.lastPrediction.shotDir.x) * (180 / Math.PI);
               }
               
               // Log immediately
               const cutAngle = this.lastPrediction.cutAngle || 0;
               const logEntry = `\n[DIRECTION CHECK] Cut: ${cutAngle.toFixed(1)}� | Shot: ${shotAngle.toFixed(1)}� | Raw: ${rawAngle.toFixed(1)}� | Pred: ${predAngle.toFixed(1)}� | Act: ${actualAngle.toFixed(1)}� | Err: ${angleDeg.toFixed(2)}�\n`;
               this.predictionLogs.push(logEntry);
               console.log(logEntry);
               
               // Stop monitoring
               this.shotMonitor.active = false;
             }
           }
        }
      }
      
      if (this.shotMonitor.active) {
        this.shotMonitor.rafId = requestAnimationFrame(monitorLoop);
      }
    };
    
    this.shotMonitor.rafId = requestAnimationFrame(monitorLoop);
  };
  
  // Store all prediction logs for export
  predictionLogs: string[] = [];
  
  handleShotEndPrediction = () => {
    // Stop monitoring if still active
    this.shotMonitor.active = false;
    if (this.shotMonitor.rafId) {
      cancelAnimationFrame(this.shotMonitor.rafId);
      this.shotMonitor.rafId = null;
    }
    
    // Reset pocketable shots cache so 'p' will rescan after shot
    this.pocketableShots = [];
    this.currentPocketShotIndex = -1;
    
    // Verify guide prediction accuracy
    this.verifyGuidePrediction();

    if (!this.showDevPrediction || !this.lastPrediction.cueBallEnd) {
      this.lastPrediction.locked = false; // Unlock for next shot
      return;
    }
    
    // Capture start positions (current positions before we wait)
    // Actually, shot-end fires when balls stop, so these ARE the end positions?
    // If shot-end fires early, these are intermediate positions.
    
    const checkStabilityAndLog = (attempts = 0) => {
      if (attempts > 20) { // Timeout after 2 seconds
        this.logPredictionResult();
        return;
      }
      
      // Store current positions
      const currentPositions = new Map();
      this.context.balls?.forEach(b => {
        currentPositions.set(b.key, { x: b.position.x, y: b.position.y });
      });
      
      // Wait 100ms and check if they moved
      setTimeout(() => {
        let moved = false;
        this.context.balls?.forEach(b => {
          const prev = currentPositions.get(b.key);
          if (prev) {
            const dist = Math.sqrt(Math.pow(b.position.x - prev.x, 2) + Math.pow(b.position.y - prev.y, 2));
            if (dist > 0.001) moved = true;
          }
        });
        
        if (moved) {
          // Still moving, wait longer
          checkStabilityAndLog(attempts + 1);
        } else {
          // Stable, log result
          this.logPredictionResult();
        }
      }, 100);
    };
    
    checkStabilityAndLog();
  };

  logPredictionResult = () => {
      const infoEl = document.getElementById('dev-prediction-info');
      if (!infoEl) return;
      
      const timestamp = new Date().toISOString();
      let report = '<b>PREDICTION ACCURACY:</b><br>';
      let logEntry = `\n=== Shot ${this.predictionLogs.length + 1} @ ${timestamp} ===\n`;
      logEntry += `Power: ${(this.lastPrediction.power * 100).toFixed(0)}%\n`;
      logEntry += `Hit Type: ${this.lastPrediction.hitType}\n`;
      
      // Find cue ball current position
      const cueBall = this.context.balls?.find(b => b.color === 'white');
      if (cueBall && this.lastPrediction.cueBallEnd) {
        const dx = cueBall.position.x - this.lastPrediction.cueBallEnd.x;
        const dy = cueBall.position.y - this.lastPrediction.cueBallEnd.y;
        const errorDist = Math.sqrt(dx * dx + dy * dy);
        report += `Cue ball error: ${(errorDist * 1000).toFixed(1)}mm<br>`;
        report += `  Predicted: (${this.lastPrediction.cueBallEnd.x.toFixed(3)}, ${this.lastPrediction.cueBallEnd.y.toFixed(3)})<br>`;
        report += `  Actual: (${cueBall.position.x.toFixed(3)}, ${cueBall.position.y.toFixed(3)})<br>`;
        report += `  ?x: ${(dx * 1000).toFixed(1)}mm, ?y: ${(dy * 1000).toFixed(1)}mm<br>`;
        
        logEntry += `CUE BALL (r=${cueBall.radius}):\n`;
        logEntry += `  Error: ${(errorDist * 1000).toFixed(1)}mm\n`;
        logEntry += `  Predicted: (${this.lastPrediction.cueBallEnd.x.toFixed(4)}, ${this.lastPrediction.cueBallEnd.y.toFixed(4)})\n`;
        logEntry += `  Actual: (${cueBall.position.x.toFixed(4)}, ${cueBall.position.y.toFixed(4)})\n`;
        logEntry += `  Delta: ?x=${(dx * 1000).toFixed(1)}mm, ?y=${(dy * 1000).toFixed(1)}mm\n`;
      } else if (!cueBall) {
        report += `Cue ball: POCKETED<br>`;
        logEntry += `CUE BALL: POCKETED\n`;
      }
      
      // Find target ball current position
      if (this.lastPrediction.targetBallEnd && this.lastPrediction.targetBallKey) {
        const targetBall = this.context.balls?.find(b => b.key === this.lastPrediction.targetBallKey);
        if (targetBall) {
          const dx = targetBall.position.x - this.lastPrediction.targetBallEnd.x;
          const dy = targetBall.position.y - this.lastPrediction.targetBallEnd.y;
          const errorDist = Math.sqrt(dx * dx + dy * dy);
          report += `Target ball error: ${(errorDist * 1000).toFixed(1)}mm<br>`;
          report += `  Predicted: (${this.lastPrediction.targetBallEnd.x.toFixed(3)}, ${this.lastPrediction.targetBallEnd.y.toFixed(3)})<br>`;
          report += `  Actual: (${targetBall.position.x.toFixed(3)}, ${targetBall.position.y.toFixed(3)})<br>`;
          report += `  ?x: ${(dx * 1000).toFixed(1)}mm, ?y: ${(dy * 1000).toFixed(1)}mm<br>`;
          
          logEntry += `TARGET BALL (${this.lastPrediction.targetBallKey}, r=${targetBall.radius}):\n`;
          logEntry += `  Error: ${(errorDist * 1000).toFixed(1)}mm\n`;
          logEntry += `  Predicted: (${this.lastPrediction.targetBallEnd.x.toFixed(4)}, ${this.lastPrediction.targetBallEnd.y.toFixed(4)})\n`;
          logEntry += `  Actual: (${targetBall.position.x.toFixed(4)}, ${targetBall.position.y.toFixed(4)})\n`;
          logEntry += `  Delta: ?x=${(dx * 1000).toFixed(1)}mm, ?y=${(dy * 1000).toFixed(1)}mm\n`;
        } else {
          report += `Target ball: POCKETED<br>`;
          logEntry += `TARGET BALL (${this.lastPrediction.targetBallKey}): POCKETED\n`;
        }
      }
      
      // Store log entry
      this.predictionLogs.push(logEntry);
      
      infoEl.innerHTML = report;
      console.log('Prediction Report:', report.replace(/<br>/g, '\n').replace(/<\/?b>/g, ''));
      
      // Unlock prediction for next shot
      this.lastPrediction.locked = false;
  };
  
  // Verify if the guide's prediction was correct
  verifyGuidePrediction = () => {
    // Stop the first contact monitor
    if (this.firstContactMonitorId) {
      cancelAnimationFrame(this.firstContactMonitorId);
      this.firstContactMonitorId = null;
    }
    
    const guidePredictedHit = this.lastPrediction.guideHitType === 'ball';
    const guidePredictedBallKey = this.lastPrediction.guideHitBallKey;
    
    // Use the ACTUAL first contact (tracked during real gameplay), not simulation
    const actualHitBall = this.lastPrediction.actualFirstHitType === 'ball';
    const actualHitBallKey = this.lastPrediction.actualFirstHitBallKey;
    
    let isCorrect = false;
    let message = '';
    let logEntry = '';
    
    if (guidePredictedHit && actualHitBall) {
      // Guide said ball, actually hit a ball first
      if (guidePredictedBallKey === actualHitBallKey) {
        isCorrect = true;
        message = '?? CONGRATS! ??';
        logEntry = `[GUIDE VERIFY] ? CORRECT - Guide predicted ball hit (${guidePredictedBallKey}), actually hit same ball first\n`;
      } else {
        isCorrect = false;
        message = '?? BOOO! ??';
        logEntry = `[GUIDE VERIFY] ? WRONG - Guide predicted ball ${guidePredictedBallKey}, but hit ${actualHitBallKey} first\n`;
      }
    } else if (guidePredictedHit && !actualHitBall) {
      // Guide said ball, but actually hit wall first (no ball moved before bouncing)
      isCorrect = false;
      message = '?? BOOO! ??';
      logEntry = `[GUIDE VERIFY] ? WRONG - Guide predicted ball hit (${guidePredictedBallKey}), but hit WALL first\n`;
    } else if (!guidePredictedHit && actualHitBall) {
      // Guide said wall, but actually hit a ball first
      isCorrect = false;
      message = '?? BOOO! ??';
      logEntry = `[GUIDE VERIFY] ? WRONG - Guide predicted WALL, but hit ball (${actualHitBallKey}) first\n`;
    } else {
      // Guide said wall, and actually hit wall first (no ball moved)
      isCorrect = true;
      message = '?? CONGRATS! ??';
      logEntry = `[GUIDE VERIFY] ? CORRECT - Guide predicted wall, actually hit wall first\n`;
    }
    
    // Log to predictions
    this.predictionLogs.push(logEntry);
    console.log(logEntry);
    
    // Show message on screen
    const msg = document.createElement('div');
    msg.style.cssText = `
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      background: ${isCorrect ? 'rgba(0, 200, 0, 0.95)' : 'rgba(200, 0, 0, 0.95)'};
      color: white; padding: 30px 50px;
      font-family: 'Arial', sans-serif; font-size: 32px; font-weight: bold;
      border-radius: 15px; z-index: 10000;
      box-shadow: 0 0 40px ${isCorrect ? '#0f0' : '#f00'};
      text-align: center;
    `;
    msg.textContent = message;
    document.body.appendChild(msg);
    setTimeout(() => msg.remove(), 1500);
  };
  
  downloadPredictionLogs = () => {
    if (this.predictionLogs.length === 0) {
      alert('No prediction logs to download. Enable prediction test and take some shots first.');
      return;
    }
    
    const header = `EIGHT BALL PREDICTION ACCURACY LOG\nGenerated: ${new Date().toISOString()}\nTotal Shots: ${this.predictionLogs.length}\n${'='.repeat(50)}\n`;
    const content = header + this.predictionLogs.join('\n');
    
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `prediction-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  
  setupDevPredictionButton() {
    const btn = document.getElementById('dev-prediction-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        this.showDevPrediction = !this.showDevPrediction;
        btn.textContent = this.showDevPrediction ? 'Hide Prediction Test' : 'Show Prediction Test';
        btn.style.background = this.showDevPrediction ? '#663399' : '#333';
        
        const infoEl = document.getElementById('dev-prediction-info');
        if (infoEl && !this.showDevPrediction) {
          infoEl.innerHTML = '';
        }
        
        // Show/hide download button
        const downloadBtn = document.getElementById('dev-prediction-download');
        if (downloadBtn) {
          downloadBtn.style.display = this.showDevPrediction ? 'inline-block' : 'none';
        }
      });
    }
    
    // Create download button if it doesn't exist
    let downloadBtn = document.getElementById('dev-prediction-download');
    if (!downloadBtn && btn) {
      downloadBtn = document.createElement('button');
      downloadBtn.id = 'dev-prediction-download';
      downloadBtn.textContent = 'Download Log';
      downloadBtn.style.cssText = 'position:fixed;top:50px;right:10px;z-index:10000;padding:8px 16px;background:#228b22;color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;display:none;';
      downloadBtn.addEventListener('click', () => this.downloadPredictionLogs());
      document.body.appendChild(downloadBtn);
    }
  }

  powerCleanup?: () => void;
  
  // Power bar elements for visual sync
  powerHandle?: HTMLElement;
  powerTrack?: HTMLElement;

  setupPowerControl() {
    // Get power bar elements
    this.powerHandle = document.querySelector('.power-handle') as HTMLElement;
    this.powerTrack = document.querySelector('.power-track') as HTMLElement;
  }
  
  updatePowerBars(power: number) {
    // Update handle position - moves DOWN as power increases
    // Handle stays within track bounds (top: 4px to bottom with handle height accounted for)
    // Track is 320px, handle is 80px, so max travel is about 70% to stay inside
    if (this.powerHandle) {
      const maxTravel = 72; // percentage - keeps handle inside track
      const handleTop = 1 + (power * maxTravel);
      this.powerHandle.style.top = `${handleTop}%`;
    }
    
    // Update track opacity - starts transparent (0.3), becomes fully visible (1.0) at full power
    if (this.powerTrack) {
      const opacity = 0.3 + (power * 0.7);
      this.powerTrack.style.opacity = String(opacity);
    }
  }
  
  resetPowerBars() {
    // Reset power bar to rest position (top) - instant, no transition
    if (this.powerHandle) {
      this.powerHandle.style.top = '1%';
    }
    
    // Reset track to transparent
    if (this.powerTrack) {
      this.powerTrack.style.opacity = '0.3';
    }
  }

  addSvgDefs(svg: SVGSVGElement) {
    // Check if defs already exist
    if (svg.querySelector('defs#ball-defs')) return;

    const defs = document.createElementNS(SVG_NS, "defs");
    defs.id = "ball-defs";

    // Ball highlight gradient - gives 3D glossy look
    const highlightGradient = document.createElementNS(SVG_NS, "radialGradient");
    highlightGradient.id = "ball-highlight-gradient";
    highlightGradient.setAttribute("cx", "30%");
    highlightGradient.setAttribute("cy", "30%");
    highlightGradient.setAttribute("r", "70%");

    const stop1 = document.createElementNS(SVG_NS, "stop");
    stop1.setAttribute("offset", "0%");
    stop1.setAttribute("stop-color", "white");
    stop1.setAttribute("stop-opacity", "0.6");
    highlightGradient.appendChild(stop1);

    const stop2 = document.createElementNS(SVG_NS, "stop");
    stop2.setAttribute("offset", "40%");
    stop2.setAttribute("stop-color", "white");
    stop2.setAttribute("stop-opacity", "0.1");
    highlightGradient.appendChild(stop2);

    const stop3 = document.createElementNS(SVG_NS, "stop");
    stop3.setAttribute("offset", "100%");
    stop3.setAttribute("stop-color", "black");
    stop3.setAttribute("stop-opacity", "0.35");
    highlightGradient.appendChild(stop3);

    defs.appendChild(highlightGradient);

    // Ball shadow blur filter
    const shadowFilter = document.createElementNS(SVG_NS, "filter");
    shadowFilter.id = "ball-shadow-blur";
    shadowFilter.setAttribute("x", "-50%");
    shadowFilter.setAttribute("y", "-50%");
    shadowFilter.setAttribute("width", "200%");
    shadowFilter.setAttribute("height", "200%");
    const feGaussianBlur = document.createElementNS(SVG_NS, "feGaussianBlur");
    feGaussianBlur.setAttribute("in", "SourceGraphic");
    feGaussianBlur.setAttribute("stdDeviation", "0.008");
    shadowFilter.appendChild(feGaussianBlur);
    defs.appendChild(shadowFilter);

    // Wood grain gradient for rails
    const woodGradient = document.createElementNS(SVG_NS, "linearGradient");
        // Outer frame wood gradient (distinct, deeper tone)
        const frameWood = document.createElementNS(SVG_NS, "linearGradient");
        frameWood.id = "frame-wood";
        frameWood.setAttribute("x1", "0%");
        frameWood.setAttribute("y1", "0%");
        frameWood.setAttribute("x2", "100%");
        frameWood.setAttribute("y2", "100%");
        const frameStops = [
          { offset: "0%", color: "#3b2414" },
          { offset: "25%", color: "#4a2e19" },
          { offset: "50%", color: "#56351e" },
          { offset: "75%", color: "#432918" },
          { offset: "100%", color: "#2e1b10" },
        ];
        frameStops.forEach(({ offset, color }) => {
          const s = document.createElementNS(SVG_NS, "stop");
          s.setAttribute("offset", offset);
          s.setAttribute("stop-color", color);
          frameWood.appendChild(s);
        });
        defs.appendChild(frameWood);
    woodGradient.id = "wood-grain";
    woodGradient.setAttribute("x1", "0%");
    woodGradient.setAttribute("y1", "0%");
    woodGradient.setAttribute("x2", "100%");
    woodGradient.setAttribute("y2", "100%");

    const woodStops = [
      { offset: "0%", color: "#5d3a1a" },
      { offset: "20%", color: "#6b4423" },
      { offset: "40%", color: "#4a2c12" },
      { offset: "60%", color: "#6b4423" },
      { offset: "80%", color: "#5d3a1a" },
      { offset: "100%", color: "#4a2c12" },
    ];
    woodStops.forEach(({ offset, color }) => {
      const stop = document.createElementNS(SVG_NS, "stop");
      stop.setAttribute("offset", offset);
      stop.setAttribute("stop-color", color);
      woodGradient.appendChild(stop);
    });
    defs.appendChild(woodGradient);

    // Felt texture gradient
    const feltGradient = document.createElementNS(SVG_NS, "radialGradient");
    feltGradient.id = "felt-gradient";
    feltGradient.setAttribute("cx", "50%");
    feltGradient.setAttribute("cy", "50%");
    feltGradient.setAttribute("r", "70%");

    const feltStop1 = document.createElementNS(SVG_NS, "stop");
    feltStop1.setAttribute("offset", "0%");
    feltStop1.setAttribute("stop-color", "#0d5c35");
    feltGradient.appendChild(feltStop1);

    const feltStop2 = document.createElementNS(SVG_NS, "stop");
    feltStop2.setAttribute("offset", "100%");
    feltStop2.setAttribute("stop-color", "#073d22");
    feltGradient.appendChild(feltStop2);

    defs.appendChild(feltGradient);

    // Pocket gradient for depth - darker to match being cut into wood
    const pocketGradient = document.createElementNS(SVG_NS, "radialGradient");
    pocketGradient.id = "pocket-gradient";
    pocketGradient.setAttribute("cx", "50%");
    pocketGradient.setAttribute("cy", "50%");
    pocketGradient.setAttribute("r", "50%");

    const pocketStop1 = document.createElementNS(SVG_NS, "stop");
    pocketStop1.setAttribute("offset", "0%");
    pocketStop1.setAttribute("stop-color", "#000000");
    pocketGradient.appendChild(pocketStop1);

    const pocketStop2 = document.createElementNS(SVG_NS, "stop");
    pocketStop2.setAttribute("offset", "70%");
    pocketStop2.setAttribute("stop-color", "#000000");
    pocketGradient.appendChild(pocketStop2);

    const pocketStop3 = document.createElementNS(SVG_NS, "stop");
    pocketStop3.setAttribute("offset", "100%");
    pocketStop3.setAttribute("stop-color", "#1a1008");
    pocketGradient.appendChild(pocketStop3);

    defs.appendChild(pocketGradient);

    // Horizontal rails (top/bottom) - grain runs along the length of the rail
    const railHorizontal = document.createElementNS(SVG_NS, "linearGradient");
    railHorizontal.id = "rail-horizontal";
    railHorizontal.setAttribute("x1", "0%");
    railHorizontal.setAttribute("y1", "0%");
    railHorizontal.setAttribute("x2", "100%");
    railHorizontal.setAttribute("y2", "0%");

    // Wood grain - subtle variation along the length
    const hGrainStops = [
      { offset: "0%", color: "#5a3d2b" },
      { offset: "10%", color: "#4e3222" },
      { offset: "25%", color: "#5a3d2b" },
      { offset: "40%", color: "#523828" },
      { offset: "55%", color: "#5a3d2b" },
      { offset: "70%", color: "#4e3222" },
      { offset: "85%", color: "#5a3d2b" },
      { offset: "100%", color: "#523828" },
    ];
    hGrainStops.forEach(({ offset, color }) => {
      const stop = document.createElementNS(SVG_NS, "stop");
      stop.setAttribute("offset", offset);
      stop.setAttribute("stop-color", color);
      railHorizontal.appendChild(stop);
    });
    defs.appendChild(railHorizontal);

    // Vertical rails (left/right) - grain runs along the length of the rail
    const railVertical = document.createElementNS(SVG_NS, "linearGradient");
    railVertical.id = "rail-vertical";
    railVertical.setAttribute("x1", "0%");
    railVertical.setAttribute("y1", "0%");
    railVertical.setAttribute("x2", "0%");
    railVertical.setAttribute("y2", "100%");

    // Wood grain - subtle variation along the length
    const vGrainStops = [
      { offset: "0%", color: "#5a3d2b" },
      { offset: "10%", color: "#4e3222" },
      { offset: "25%", color: "#5a3d2b" },
      { offset: "40%", color: "#523828" },
      { offset: "55%", color: "#5a3d2b" },
      { offset: "70%", color: "#4e3222" },
      { offset: "85%", color: "#5a3d2b" },
      { offset: "100%", color: "#523828" },
    ];
    vGrainStops.forEach(({ offset, color }) => {
      const stop = document.createElementNS(SVG_NS, "stop");
      stop.setAttribute("offset", offset);
      stop.setAttribute("stop-color", color);
      railVertical.appendChild(stop);
    });
    defs.appendChild(railVertical);

    // Metal dot gradient for decorative screws/inlays
    const metalGradient = document.createElementNS(SVG_NS, "radialGradient");
    metalGradient.id = "metal-dot";
    metalGradient.setAttribute("cx", "35%");
    metalGradient.setAttribute("cy", "35%");
    metalGradient.setAttribute("r", "60%");

    const metalStop1 = document.createElementNS(SVG_NS, "stop");
    metalStop1.setAttribute("offset", "0%");
    metalStop1.setAttribute("stop-color", "#b8c4d0");
    metalGradient.appendChild(metalStop1);

    const metalStop2 = document.createElementNS(SVG_NS, "stop");
    metalStop2.setAttribute("offset", "50%");
    metalStop2.setAttribute("stop-color", "#8090a0");
    metalGradient.appendChild(metalStop2);

    const metalStop3 = document.createElementNS(SVG_NS, "stop");
    metalStop3.setAttribute("offset", "100%");
    metalStop3.setAttribute("stop-color", "#506070");
    metalGradient.appendChild(metalStop3);

    defs.appendChild(metalGradient);

    // Cue stick shaft gradient (maple wood)
    const cueShaft = document.createElementNS(SVG_NS, "linearGradient");
    cueShaft.id = "cue-shaft";
    cueShaft.setAttribute("x1", "0%");
    cueShaft.setAttribute("y1", "0%");
    cueShaft.setAttribute("x2", "0%");
    cueShaft.setAttribute("y2", "100%");
    const shaftStops = [
      { offset: "0%", color: "#f5deb3" },
      { offset: "30%", color: "#deb887" },
      { offset: "50%", color: "#f5deb3" },
      { offset: "70%", color: "#d2b48c" },
      { offset: "100%", color: "#c4a67a" },
    ];
    shaftStops.forEach(({ offset, color }) => {
      const s = document.createElementNS(SVG_NS, "stop");
      s.setAttribute("offset", offset);
      s.setAttribute("stop-color", color);
      cueShaft.appendChild(s);
    });
    defs.appendChild(cueShaft);

    // Cue stick butt gradient (darker wood)
    const cueButt = document.createElementNS(SVG_NS, "linearGradient");
    cueButt.id = "cue-butt";
    cueButt.setAttribute("x1", "0%");
    cueButt.setAttribute("y1", "0%");
    cueButt.setAttribute("x2", "0%");
    cueButt.setAttribute("y2", "100%");
    const buttStops = [
      { offset: "0%", color: "#4a3728" },
      { offset: "25%", color: "#5c4033" },
      { offset: "50%", color: "#3d2b1f" },
      { offset: "75%", color: "#5c4033" },
      { offset: "100%", color: "#4a3728" },
    ];
    buttStops.forEach(({ offset, color }) => {
      const s = document.createElementNS(SVG_NS, "stop");
      s.setAttribute("offset", offset);
      s.setAttribute("stop-color", color);
      cueButt.appendChild(s);
    });
    defs.appendChild(cueButt);

    // Drop shadow filter for depth
    const dropShadow = document.createElementNS(SVG_NS, "filter");
    dropShadow.id = "drop-shadow";
    dropShadow.setAttribute("x", "-20%");
    dropShadow.setAttribute("y", "-20%");
    dropShadow.setAttribute("width", "140%");
    dropShadow.setAttribute("height", "140%");

    const feDropShadow = document.createElementNS(SVG_NS, "feDropShadow");
    feDropShadow.setAttribute("dx", "0");
    feDropShadow.setAttribute("dy", "0.005");
    feDropShadow.setAttribute("stdDeviation", "0.008");
    feDropShadow.setAttribute("flood-color", "#000");
    feDropShadow.setAttribute("flood-opacity", "0.5");
    dropShadow.appendChild(feDropShadow);

    defs.appendChild(dropShadow);

    // Inner shadow for pockets
    const innerShadow = document.createElementNS(SVG_NS, "filter");
    innerShadow.id = "inner-shadow";
    innerShadow.setAttribute("x", "-50%");
    innerShadow.setAttribute("y", "-50%");
    innerShadow.setAttribute("width", "200%");
    innerShadow.setAttribute("height", "200%");

    const feGaussian = document.createElementNS(SVG_NS, "feGaussianBlur");
    feGaussian.setAttribute("in", "SourceAlpha");
    feGaussian.setAttribute("stdDeviation", "0.005");
    feGaussian.setAttribute("result", "blur");
    innerShadow.appendChild(feGaussian);

    const feOffset = document.createElementNS(SVG_NS, "feOffset");
    feOffset.setAttribute("in", "blur");
    feOffset.setAttribute("dx", "0");
    feOffset.setAttribute("dy", "0.003");
    feOffset.setAttribute("result", "offsetBlur");
    innerShadow.appendChild(feOffset);

    const feComposite = document.createElementNS(SVG_NS, "feComposite");
    feComposite.setAttribute("in", "SourceGraphic");
    feComposite.setAttribute("in2", "offsetBlur");
    feComposite.setAttribute("operator", "over");
    innerShadow.appendChild(feComposite);

    defs.appendChild(innerShadow);

    svg.insertBefore(defs, svg.firstChild);
  }

  handleDeactivate() {
    window.removeEventListener("resize", this.handleWindowResize);
    window.removeEventListener("orientationchange", this.handleWindowResize);
    this.container.parentElement?.removeEventListener("pointerdown", this.handlePointerDown);
    this.container.parentElement?.removeEventListener("pointermove", this.handlePointerMove);
    this.container.parentElement?.removeEventListener("pointerup", this.handlePointerUp);
    
    if (this.powerCleanup) {
      this.powerCleanup();
      this.powerCleanup = undefined;
    }

    this.container.remove();
  }

  handleStart() {}

  // Store ball rotation state
  ballState = new Map<string, { q: Quaternion; pos: { x: number; y: number }; vel: { x: number; y: number } }>();

  tableConfigMemo = Memo.init();
  handleWindowResize = () => {
    const table = this.context?.table;
    if (!this.container || !table) return;
    if (this.tableConfigMemo.update(table.width, table.height, window.innerWidth, window.innerHeight)) {
      const width = table.width * 1.3;
      const height = table.height * 1.3;
      const isPortrait = window.innerWidth < window.innerHeight;
      if (isPortrait) {
        this.container.classList.add("portrait");
        this.container.parentElement?.setAttribute("viewBox", `-${height * 0.5} -${width * 0.5} ${height} ${width}`);
      } else {
        this.container.classList.remove("portrait");
        this.container.parentElement?.setAttribute("viewBox", `-${width * 0.5} -${height * 0.5} ${width} ${height}`);
      }
    }
  };

  getSvgPoint = (event: PointerEvent) => {
    if (!this.container) return;
    const domPoint = new DOMPoint(event.clientX, event.clientY);
    const transform = this.container.getScreenCTM();
    if (!transform) return;
    const svgPoint = domPoint.matrixTransform(transform.inverse());
    return svgPoint;
  };

  pointerDown = false;
  dragStartPoint: { x: number; y: number } | null = null;
  currentPower: number = 0;
  displayPower: number = 0; // Smoothed power for visual display

  handlePointerDown = (event: PointerEvent) => {
    // Handle ball placement mode
    if (this.context.ballInHand) {
      this.handlePlacementPointerDown(event);
      return;
    }
    
    this.pointerDown = true;
    const point = this.getSvgPoint(event);
    if (!point) return;
    this.dragStartPoint = { x: point.x, y: point.y };
    this.currentPower = 0;
    this.displayPower = 0;
    this.emit("user-pointer-start", point);
  };

  handlePointerMove = (event: PointerEvent) => {
    // Handle ball placement mode
    if (this.context.ballInHand) {
      this.handlePlacementPointerMove(event);
      return;
    }
    
    const point = this.getSvgPoint(event);
    if (!point) return;
    
    // If NOT dragging, allow free aiming (cue follows mouse)
    if (!this.pointerDown) {
      this.emit("user-pointer-move", point);
      return;
    }
    
    // If dragging, calculate power based on pull-back distance
    // Aim direction is locked when pointer went down
    if (this.dragStartPoint) {
      const cueBall = this.context.balls?.find(b => b.color === 'white');
      if (cueBall) {
        // Calculate how far we've pulled TOWARD the cue ball (to fire in aim direction)
        const startToBall = {
          x: cueBall.position.x - this.dragStartPoint.x,
          y: cueBall.position.y - this.dragStartPoint.y
        };
        const currentToBall = {
          x: cueBall.position.x - point.x,
          y: cueBall.position.y - point.y
        };
        
        const startDist = Math.sqrt(startToBall.x * startToBall.x + startToBall.y * startToBall.y);
        const currentDist = Math.sqrt(currentToBall.x * currentToBall.x + currentToBall.y * currentToBall.y);
        
        // Power based on how much CLOSER to ball we are now vs start (pulling toward = power)
        const pullForward = Math.max(0, startDist - currentDist);
        const maxPullForward = 0.12; // Max pull distance for full power
        const targetPower = Math.min(1, pullForward / maxPullForward);
        
        // Smooth interpolation for display (lerp toward target)
        const smoothFactor = 0.25; // Higher = faster response, lower = smoother
        this.displayPower += (targetPower - this.displayPower) * smoothFactor;
        this.currentPower = targetPower; // Keep actual power for shot
        
        // Update power bars visually with smoothed value
        this.updatePowerBars(this.displayPower);
        
        this.emit("user-power-change", this.displayPower);
      }
    }
  };

  handlePointerUp = (event: PointerEvent) => {
    // Handle ball placement mode
    if (this.context.ballInHand) {
      this.handlePlacementPointerUp(event);
      return;
    }
    
    if (this.pointerDown && this.dragStartPoint) {
      // Fire shot with current power
      this.emit("user-power-release", this.currentPower);
      
      // Reset power bars
      this.resetPowerBars();
    }
    
    this.pointerDown = false;
    this.dragStartPoint = null;
    this.currentPower = 0;
    this.displayPower = 0;
  };

  // Ball in hand state
  placementBall: SVGElement | null = null;
  placementPosition: { x: number; y: number } = { x: 0, y: 0 };
  isDraggingPlacement = false;
  
  handleBallInHand = () => {
    if (!this.context.table) return;
    
    const table = this.context.table;
    const w = table.width;
    const h = table.height;
    const r = table.ballRadius;
    
    // Headstring line is at 1/4 of the table from left (the "kitchen" line)
    const headstringX = -w / 4;
    
    // Draw headstring line
    this.headstringGroup.innerHTML = '';
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(headstringX));
    line.setAttribute("y1", String(-h / 2 + r));
    line.setAttribute("x2", String(headstringX));
    line.setAttribute("y2", String(h / 2 - r));
    line.setAttribute("stroke", "rgba(255, 255, 255, 0.4)");
    line.setAttribute("stroke-width", "0.003");
    line.setAttribute("stroke-dasharray", "0.02 0.01");
    this.headstringGroup.appendChild(line);
    
    // Create placement ball (ghost ball that player can drag)
    this.placementBallGroup.innerHTML = '';
    
    // Initial position - center of kitchen (between left edge and headstring)
    // headstringX is at -w/4, so center of kitchen is at (-w/2 + headstringX) / 2 = -3w/8
    this.placementPosition = { x: (-w / 2 + headstringX) / 2, y: 0 };
    
    const ballGroup = document.createElementNS(SVG_NS, "g");
    ballGroup.classList.add("placement-ball");
    ballGroup.setAttribute("transform", `translate(${this.placementPosition.x}, ${this.placementPosition.y})`);
    
    // Ball circle
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("r", String(r));
    circle.setAttribute("fill", "#f8f8f0");
    circle.setAttribute("stroke", "rgba(0, 255, 0, 0.8)");
    circle.setAttribute("stroke-width", "0.003");
    circle.style.cursor = "grab";
    ballGroup.appendChild(circle);
    
    // Pulsing ring to indicate draggable
    const pulseRing = document.createElementNS(SVG_NS, "circle");
    pulseRing.setAttribute("r", String(r * 1.5));
    pulseRing.setAttribute("fill", "none");
    pulseRing.setAttribute("stroke", "rgba(0, 255, 0, 0.5)");
    pulseRing.setAttribute("stroke-width", "0.002");
    pulseRing.classList.add("pulse-ring");
    ballGroup.appendChild(pulseRing);
    
    this.placementBallGroup.appendChild(ballGroup);
    this.placementBall = ballGroup;
    
    // Add instruction text (centered in the kitchen area)
    const kitchenCenterX = (-w / 2 + headstringX) / 2;
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", String(kitchenCenterX));
    text.setAttribute("y", String(-h / 2 - 0.05));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("fill", "rgba(255, 255, 255, 0.8)");
    text.setAttribute("font-size", "0.04");
    text.setAttribute("font-family", "Arial, sans-serif");
    text.textContent = "Click to place ball";
    this.headstringGroup.appendChild(text);
  };
  
  handlePlacementPointerDown = (event: PointerEvent) => {
    if (!this.context.ballInHand) return;
    
    const point = this.getSvgPoint(event);
    if (!point) return;
    
    this.isDraggingPlacement = true;
    this.updatePlacementPosition(point);
  };
  
  handlePlacementPointerMove = (event: PointerEvent) => {
    if (!this.context.ballInHand || !this.isDraggingPlacement) return;
    
    const point = this.getSvgPoint(event);
    if (!point) return;
    
    this.updatePlacementPosition(point);
  };
  
  handlePlacementPointerUp = (event: PointerEvent) => {
    if (!this.context.ballInHand) return;
    
    if (this.isDraggingPlacement || this.context.ballInHand) {
      // Place the ball at current position
      this.confirmBallPlacement();
    }
    
    this.isDraggingPlacement = false;
  };
  
  updatePlacementPosition(point: { x: number; y: number }) {
    if (!this.context.table || !this.placementBall) return;
    
    const table = this.context.table;
    const w = table.width;
    const h = table.height;
    const r = table.ballRadius;
    
    // Headstring line - ball must be placed behind it (to the left)
    const headstringX = -w / 4;
    
    // Clamp position to behind the headstring and within table bounds
    const maxX = headstringX - r;
    const minX = -w / 2 + r;
    const maxY = h / 2 - r;
    const minY = -h / 2 + r;
    
    this.placementPosition.x = Math.max(minX, Math.min(maxX, point.x));
    this.placementPosition.y = Math.max(minY, Math.min(maxY, point.y));
    
    // Check collision with other balls
    const isValidPosition = this.checkPlacementCollision();
    
    // Update ball position
    this.placementBall.setAttribute("transform", 
      `translate(${this.placementPosition.x}, ${this.placementPosition.y})`);
    
    // Visual feedback for valid/invalid position
    const circle = this.placementBall.querySelector("circle") as SVGCircleElement;
    if (circle) {
      circle.setAttribute("stroke", isValidPosition ? "rgba(0, 255, 0, 0.8)" : "rgba(255, 0, 0, 0.8)");
    }
  }
  
  checkPlacementCollision(): boolean {
    if (!this.context.balls || !this.context.table) return true;
    
    const r = this.context.table.ballRadius;
    
    for (const ball of this.context.balls) {
      const dx = ball.position.x - this.placementPosition.x;
      const dy = ball.position.y - this.placementPosition.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      // Need at least 2 radii distance (both ball radii)
      if (dist < r * 2.2) {
        return false;
      }
    }
    
    return true;
  }
  
  confirmBallPlacement() {
    if (!this.context.table || !this.checkPlacementCollision()) return;
    
    const r = this.context.table.ballRadius;
    
    // Create the cue ball at the placement position
    const cueBall = new Ball(
      { x: this.placementPosition.x, y: this.placementPosition.y },
      r,
      "white"
    );
    
    this.context.balls.push(cueBall);
    
    // Clear ball in hand state
    this.context.ballInHand = false;
    this.context.foulCommitted = false;
    
    // Clear placement UI
    this.headstringGroup.innerHTML = '';
    this.placementBallGroup.innerHTML = '';
    this.placementBall = null;
    
    this.emit("update");
  }

  handleFrameLoop = () => {
    if (!this.context.balls || !this.context.rails || !this.context.pockets) return;

    const data: (Ball | Rail | Pocket | CueStick | Table)[] = [
      this.context.table,
      ...this.context.rails,
      ...this.context.pockets,
      ...this.context.balls,
    ];
    
    // Only include cue if it exists
    if (this.context.cue) {
      data.push(this.context.cue);
    }

    this.dataset.data(data);
  };

  ballDriver = Driver.create<Ball, Element>({
    filter: (data) => data.type == "ball",
    enter: (data) => {
      const group = document.createElementNS(SVG_NS, "g");
      group.classList.add("ball-group");
      
      // Initialize state if not exists - start with number facing camera (z-axis positive)
      if (!this.ballState.has(data.key)) {
        // Identity quaternion means z-axis points towards viewer, which is what we want
        this.ballState.set(data.key, { 
          q: new Quaternion(), 
          pos: { ...data.position },
          vel: { x: 0, y: 0 }
        });
      }

      // Determine ball properties
      let number: number | null = null;
      let type: 'solid' | 'stripe' | 'cue' | '8' = 'solid';
      
      if (data.color === 'white') {
        type = 'cue';
      } else if (data.color === 'black') {
        number = 8;
        type = '8';
      } else {
        const parts = data.color.split('-');
        const colorName = parts[0];
        const style = parts[1];
        
        const colorToNumber: Record<string, number> = {
          'yellow': 1, 'blue': 2, 'red': 3, 'purple': 4, 
          'orange': 5, 'green': 6, 'burgundy': 7
        };
        
        if (colorToNumber[colorName]) {
          number = colorToNumber[colorName];
          if (style === 'stripe') {
            number += 8;
            type = 'stripe';
          }
        }
      }

      const r = data.radius - STROKE_WIDTH;

      // Create Clip Path to prevent elements from sticking out
      const clipId = "clip-" + data.key;
      const defs = document.createElementNS(SVG_NS, "defs");
      const clipPath = document.createElementNS(SVG_NS, "clipPath");
      clipPath.id = clipId;
      const clipCircle = document.createElementNS(SVG_NS, "circle");
      clipCircle.setAttribute("r", String(r));
      clipPath.appendChild(clipCircle);
      defs.appendChild(clipPath);
      group.appendChild(defs);

      // 0. Shadow (underneath the ball - position updated dynamically based on table position)
      const shadow = document.createElementNS(SVG_NS, "ellipse");
      shadow.setAttribute("rx", String(r * 1.3));
      shadow.setAttribute("ry", String(r * 0.5));
      shadow.setAttribute("fill", "rgba(0,0,0,0.3)");
      shadow.setAttribute("filter", "url(#ball-shadow-blur)");
      group.appendChild(shadow);

      // 1. Base Circle (The main color - no stroke, stroke is on separate outline)
      const baseCircle = document.createElementNS(SVG_NS, "circle");
      baseCircle.setAttribute("r", String(r));
      
      // For stripes, the base is the COLOR (we will draw white caps on top)
      // For solids, the base is the COLOR
      // For cue, base is white
      if (type === 'cue') {
        baseCircle.classList.add("ball", "white");
      } else if (type === '8') {
        baseCircle.classList.add("ball", "black");
      } else {
        // Both solid and stripe get the color base
        baseCircle.classList.add("ball", data.color.split('-')[0]);
      }
      group.appendChild(baseCircle);

      // 2. Dynamic Elements Group (Caps, Number)
      const dynamicGroup = document.createElementNS(SVG_NS, "g");
      dynamicGroup.setAttribute("clip-path", `url(#${clipId})`);
      group.appendChild(dynamicGroup);

      // 3. Gloss/Highlight (Fixed on top)
      const highlight = document.createElementNS(SVG_NS, "circle");
      highlight.setAttribute("r", String(r));
      highlight.setAttribute("cx", "0");
      highlight.setAttribute("cy", "0");
      highlight.classList.add("ball-highlight");
      group.appendChild(highlight);

      // 4. Outline (on top of everything including caps)
      const outline = document.createElementNS(SVG_NS, "circle");
      outline.setAttribute("r", String(r));
      outline.setAttribute("cx", "0");
      outline.setAttribute("cy", "0");
      outline.classList.add("ball-outline");
      group.appendChild(outline);

      // Store metadata for update (include shadow element)
      (group as any).__ballMeta = { type, number, r, dynamicGroup, shadow };

      this.ballsGroup.appendChild(group);
      return group;
    },
    update: (data, element) => {
      element.setAttribute("transform", `translate(${data.position.x}, ${data.position.y})`);

      const meta = (element as any).__ballMeta;
      if (!meta) return;
      const { type, number, r, dynamicGroup, shadow } = meta;

      // Update shadow position based on ball's position on table
      // Light source is assumed to be above center of table (0, 0)
      // Shadow offset points away from center, but very subtly
      if (shadow) {
        // Normalize position to table size (assuming table is roughly 1.8 x 0.9)
        const normalizedX = data.position.x / 0.9;
        const normalizedY = data.position.y / 0.45;
        
        // Very subtle offset based on position - shadow stays close to ball
        const shadowOffsetX = normalizedX * r * 0.15;
        const shadowOffsetY = r * 0.35 + normalizedY * r * 0.1; // Always slightly below, varies a bit
        
        shadow.setAttribute("cx", String(shadowOffsetX));
        shadow.setAttribute("cy", String(shadowOffsetY));
      }

      // Update Rotation State
      let state = this.ballState.get(data.key);
      if (!state) {
         state = { q: new Quaternion(), pos: { ...data.position }, vel: { x: 0, y: 0 } };
         this.ballState.set(data.key, state);
      }

      // Calculate movement delta
      const dx = data.position.x - state.pos.x;
      const dy = data.position.y - state.pos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Store velocity (movement since last frame)
      state.vel.x = dx;
      state.vel.y = dy;

      // Update stored position
      state.pos.x = data.position.x;
      state.pos.y = data.position.y;

      // Update Quaternion based on rolling
      if (dist > 0.0001) {
        const axis = { x: -dy / dist, y: dx / dist, z: 0 };
        const angle = dist / data.radius; 
        const qRot = Quaternion.fromAxisAngle(axis, angle);
        state.q = qRot.multiply(state.q).normalize();
      }
      
      // Clear dynamic elements
      while (dynamicGroup.firstChild) {
        dynamicGroup.removeChild(dynamicGroup.firstChild);
      }

      // Pre-calculate rotated basis vectors
      let xAxis = state.q.rotateVector({ x: 1, y: 0, z: 0 });
      let yAxis = state.q.rotateVector({ x: 0, y: 1, z: 0 });
      let zAxis = state.q.rotateVector({ x: 0, y: 0, z: 1 });
      
      // For stripes: apply a subtle constant "viewing angle" offset so the caps
      // always appear slightly curved (like viewing from slightly above)
      if (type === 'stripe') {
        const curveBias = 0.12;
        const origY = { ...yAxis };
        const origZ = { ...zAxis };
        yAxis = {
          x: origY.x + origZ.x * curveBias,
          y: origY.y + origZ.y * curveBias,
          z: origY.z + origZ.z * curveBias
        };
        const yLen = Math.sqrt(yAxis.x ** 2 + yAxis.y ** 2 + yAxis.z ** 2);
        yAxis.x /= yLen; yAxis.y /= yLen; yAxis.z /= yLen;
      }

      // Helper to create matrix transform string
      const getMatrix = (basisX: any, basisY: any, center: any) => {
        return `matrix(${basisX.x},${basisX.y},${basisY.x},${basisY.y},${center.x},${center.y})`;
      };

      // Render Stripe Caps (White)
      if (type === 'stripe') {
        const stripeStart = r * 0.57;
        
        const drawCap = (sign: 1 | -1) => {
          const capEdgeRadius = Math.sqrt(r * r - stripeStart * stripeStart);
          const edgeCenterZ = yAxis.z * sign * stripeStart;
          const edgeReach = capEdgeRadius * Math.sqrt(xAxis.z * xAxis.z + zAxis.z * zAxis.z);
          const maxZ = edgeCenterZ + edgeReach;
          
          if (maxZ > 0) {
            const arcSamples = 200;
            
            const outerArc: {x: number, y: number, z: number}[] = [];
            for (let j = 0; j <= arcSamples; j++) {
              const theta = (j / arcSamples) * Math.PI * 2;
              const cosT = Math.cos(theta);
              const sinT = Math.sin(theta);
              
              const px = xAxis.x * capEdgeRadius * cosT + yAxis.x * stripeStart * sign + zAxis.x * capEdgeRadius * sinT;
              const py = xAxis.y * capEdgeRadius * cosT + yAxis.y * stripeStart * sign + zAxis.y * capEdgeRadius * sinT;
              const pz = xAxis.z * capEdgeRadius * cosT + yAxis.z * stripeStart * sign + zAxis.z * capEdgeRadius * sinT;
              
              outerArc.push({ x: px, y: py, z: pz });
            }
            
            const allVisible = outerArc.every(p => p.z >= 0);
            const noneVisible = outerArc.every(p => p.z < 0);
            
            if (noneVisible) return;
            
            if (allVisible) {
              // Draw the cap as a simple ellipse/circle without fake curve
              // The fake curve was causing line artifacts at certain angles
              let d = `M ${outerArc[0].x} ${outerArc[0].y}`;
              for (let k = 1; k < outerArc.length; k++) {
                d += ` L ${outerArc[k].x} ${outerArc[k].y}`;
              }
              d += ' Z';
              
              const path = document.createElementNS(SVG_NS, "path");
              path.setAttribute("d", d);
              path.setAttribute("fill", "white");
              dynamicGroup.appendChild(path);
            } else {
              let firstVisibleIdx = -1;
              for (let j = 0; j < arcSamples; j++) {
                const curr = outerArc[j].z >= 0;
                const prev = outerArc[(j - 1 + arcSamples) % arcSamples].z >= 0;
                if (curr && !prev) {
                  firstVisibleIdx = j;
                  break;
                }
              }
              
              if (firstVisibleIdx === -1) {
                for (let j = 0; j < outerArc.length; j++) {
                  if (outerArc[j].z >= 0) {
                    firstVisibleIdx = j;
                    break;
                  }
                }
              }
              
              if (firstVisibleIdx === -1) return;
              
              const visibleOuter: {x: number, y: number, z: number}[] = [];
              for (let j = 0; j < arcSamples; j++) {
                const idx = (firstVisibleIdx + j) % arcSamples;
                if (outerArc[idx].z >= 0) {
                  visibleOuter.push(outerArc[idx]);
                } else {
                  break;
                }
              }
              
              if (visibleOuter.length < 2) return;
              
              const startPt = visibleOuter[0];
              const endPt = visibleOuter[visibleOuter.length - 1];
              
              const startAngle = Math.atan2(startPt.y, startPt.x);
              const endAngle = Math.atan2(endPt.y, endPt.x);
              
              let da1 = startAngle - endAngle;
              let da2 = da1 > 0 ? da1 - 2 * Math.PI : da1 + 2 * Math.PI;
              let da = Math.abs(da1) < Math.abs(da2) ? da1 : da2;
              
              const innerArc: {x: number, y: number}[] = [];
              const innerSamples = Math.max(20, Math.abs(Math.round(da * 20)));
              for (let k = 0; k <= innerSamples; k++) {
                const t = k / innerSamples;
                const angle = endAngle + da * t;
                innerArc.push({ x: r * Math.cos(angle), y: r * Math.sin(angle) });
              }
              
              let d = `M ${visibleOuter[0].x} ${visibleOuter[0].y}`;
              for (let k = 1; k < visibleOuter.length; k++) {
                d += ` L ${visibleOuter[k].x} ${visibleOuter[k].y}`;
              }
              for (let k = 0; k < innerArc.length; k++) {
                d += ` L ${innerArc[k].x} ${innerArc[k].y}`;
              }
              d += ' Z';
              
              const path = document.createElementNS(SVG_NS, "path");
              path.setAttribute("d", d);
              path.setAttribute("fill", "white");
              dynamicGroup.appendChild(path);
            }
          }
        };
        
        drawCap(1);
        drawCap(-1);
      }

      // Render Number Spot (White) with proper 3D curvature
      if (number !== null) {
        const spotScale = 0.95;
        const dotRadius = r * 0.48 * spotScale;
        
        // Calculate visibility - dot can be visible even if center is behind
        const dotAngularRadius = Math.asin(Math.min(dotRadius / r, 1));
        const dotCenterDist = r * Math.cos(dotAngularRadius);
        const dotPlaneRadius = r * Math.sin(dotAngularRadius);
        
        const dotEdgeReach = dotPlaneRadius * Math.sqrt(xAxis.z * xAxis.z + yAxis.z * yAxis.z);
        const dotCenterZ = zAxis.z * dotCenterDist;
        const dotMaxZ = dotCenterZ + dotEdgeReach;
        
        if (dotMaxZ > 0) {
          const numCenter = { x: zAxis.x * r, y: zAxis.y * r, z: zAxis.z * r };
          const scale = Math.max(0.01, Math.abs(numCenter.z) / r);
          const angle = Math.atan2(numCenter.y, numCenter.x) * 180 / Math.PI;
          
          // Sample points around the dot circle
          const arcSamples = 100;
          const dotPoints: {x: number, y: number, z: number}[] = [];
          
          for (let j = 0; j <= arcSamples; j++) {
            const theta = (j / arcSamples) * Math.PI * 2;
            const cosT = Math.cos(theta);
            const sinT = Math.sin(theta);
            
            const px = xAxis.x * dotPlaneRadius * cosT + yAxis.x * dotPlaneRadius * sinT + zAxis.x * dotCenterDist;
            const py = xAxis.y * dotPlaneRadius * cosT + yAxis.y * dotPlaneRadius * sinT + zAxis.y * dotCenterDist;
            const pz = xAxis.z * dotPlaneRadius * cosT + yAxis.z * dotPlaneRadius * sinT + zAxis.z * dotCenterDist;
            
            dotPoints.push({ x: px, y: py, z: pz });
          }
          
          const allVisible = dotPoints.every(p => p.z >= 0);
          
          if (allVisible) {
            let d = `M ${dotPoints[0].x} ${dotPoints[0].y}`;
            for (let k = 1; k < dotPoints.length; k++) {
              d += ` L ${dotPoints[k].x} ${dotPoints[k].y}`;
            }
            d += ' Z';
            
            const dotPath = document.createElementNS(SVG_NS, "path");
            dotPath.setAttribute("d", d);
            dotPath.setAttribute("fill", "white");
            dynamicGroup.appendChild(dotPath);
          } else {
            let firstVisibleIdx = -1;
            for (let j = 0; j < arcSamples; j++) {
              const curr = dotPoints[j].z >= 0;
              const prev = dotPoints[(j - 1 + arcSamples) % arcSamples].z >= 0;
              if (curr && !prev) {
                firstVisibleIdx = j;
                break;
              }
            }
            
            if (firstVisibleIdx === -1) {
              for (let j = 0; j < dotPoints.length; j++) {
                if (dotPoints[j].z >= 0) {
                  firstVisibleIdx = j;
                  break;
                }
              }
            }
            
            if (firstVisibleIdx !== -1) {
              const visibleOuter: {x: number, y: number, z: number}[] = [];
              for (let j = 0; j < arcSamples; j++) {
                const idx = (firstVisibleIdx + j) % arcSamples;
                if (dotPoints[idx].z >= 0) {
                  visibleOuter.push(dotPoints[idx]);
                } else {
                  break;
                }
              }
              
              if (visibleOuter.length >= 2) {
                const startPt = visibleOuter[0];
                const endPt = visibleOuter[visibleOuter.length - 1];
                
                const startAngle = Math.atan2(startPt.y, startPt.x);
                const endAngle = Math.atan2(endPt.y, endPt.x);
                
                let da1 = startAngle - endAngle;
                let da2 = da1 > 0 ? da1 - 2 * Math.PI : da1 + 2 * Math.PI;
                let da = Math.abs(da1) < Math.abs(da2) ? da1 : da2;
                
                const innerArc: {x: number, y: number}[] = [];
                const innerSamples = Math.max(20, Math.abs(Math.round(da * 20)));
                for (let k = 0; k <= innerSamples; k++) {
                  const t = k / innerSamples;
                  const ang = endAngle + da * t;
                  innerArc.push({ x: r * Math.cos(ang), y: r * Math.sin(ang) });
                }
                
                let d = `M ${visibleOuter[0].x} ${visibleOuter[0].y}`;
                for (let k = 1; k < visibleOuter.length; k++) {
                  d += ` L ${visibleOuter[k].x} ${visibleOuter[k].y}`;
                }
                for (let k = 0; k < innerArc.length; k++) {
                  d += ` L ${innerArc[k].x} ${innerArc[k].y}`;
                }
                d += ' Z';
                
                const dotPath = document.createElementNS(SVG_NS, "path");
                dotPath.setAttribute("d", d);
                dotPath.setAttribute("fill", "white");
                dynamicGroup.appendChild(dotPath);
              }
            }
          }
          
          // Text - only show when center is in front
          if (numCenter.z > 0) {
            const spot = document.createElementNS(SVG_NS, "g");
            // Use basis vectors for transform to ensure number rotates with ball
            spot.setAttribute("transform",
              `matrix(${xAxis.x}, ${xAxis.y}, ${yAxis.x}, ${yAxis.y}, ${numCenter.x}, ${numCenter.y})`
            );
            
            // Ball text adjustments for centering (values are for r=0.5, scale by r/0.5 = r*2)
            const ballTextAdjustments: Record<number, {x: number, y: number, size: number}> = {
              1: { x: -0.0100, y: 0.0000, size: 0.91 },
              2: { x: 0.0020, y: -0.0050, size: 0.85 },
              3: { x: 0, y: 0, size: 0.85 },
              4: { x: -0.0100, y: 0.0000, size: 0.89 },
              5: { x: -0.0060, y: 0.0060, size: 0.85 },
              6: { x: -0.0070, y: 0.0000, size: 0.88 },
              7: { x: 0.0060, y: 0.0130, size: 0.88 },
              8: { x: 0.0000, y: 0.0000, size: 0.88 },
              9: { x: 0, y: 0, size: 0.85 },
              10: { x: -0.0125, y: 0.0000, size: 0.78 },
              11: { x: -0.0125, y: 0.0000, size: 0.78 },
              12: { x: -0.0195, y: -0.0020, size: 0.74 },
              13: { x: -0.0125, y: 0.0000, size: 0.75 },
              14: { x: -0.0195, y: 0.0000, size: 0.77 },
              15: { x: -0.0145, y: 0.0080, size: 0.75 },
            };
            
            const adj = ballTextAdjustments[number] || { x: 0, y: 0, size: 0.85 };
            // Scale adjustments by r/0.5 since values were tuned for r=0.5
            const rScale = r / 0.5;
            
            const text = document.createElementNS(SVG_NS, "text");
            text.textContent = String(number);
            text.classList.add("ball-text");
            text.setAttribute("x", String(adj.x * rScale));
            text.setAttribute("y", String(adj.y * rScale));
            text.setAttribute("font-size", String(r * adj.size * spotScale));
            text.setAttribute("text-anchor", "middle");
            text.setAttribute("dominant-baseline", "central");
            spot.appendChild(text);
            dynamicGroup.appendChild(spot);
          }
        }
      }
    },
    exit: (data, element) => {
      // Velocity before removing state (for momentum continuation)
      const state = this.ballState.get(data.key);
      const velocity = state?.vel || { x: 0, y: 0 };
      this.ballState.delete(data.key);

      const group = element as SVGGElement;
      const transform = group.getAttribute("transform") || "";
      const match = transform.match(/translate\(([-\d.]+),\s*([-\d.]+)\)/);
      if (!match) { element.remove(); return; }

      const startX = parseFloat(match[1]);
      const startY = parseFloat(match[2]);

      // Get ball radius from meta
      const meta = (group as any).__ballMeta;
      const ballRadius = meta ? meta.r : 0.028;

      // Find nearest pocket center
      const pockets = this.context.pockets || [];
      let nearestPocket = { x: startX, y: startY, radius: 0.05 };
      let minDist = Infinity;
      for (const pocket of pockets) {
        const dx = pocket.position.x - startX;
        const dy = pocket.position.y - startY;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < minDist) { minDist = d; nearestPocket = { x: pocket.position.x, y: pocket.position.y, radius: pocket.radius }; }
      }

      // Trajectory Calculation
      // We use a constant acceleration model to ensure smooth transition from current velocity
      // P(t) = P0 + V0*t + 0.5*A*t^2
      // We want P(T) = Target.
      // A = 2(Target - P0 - V0*T) / T^2
      
      const targetX = nearestPocket.x;
      const targetY = nearestPocket.y;
      
      // Distance check to determine duration
      const distX = targetX - startX;
      const distY = targetY - startY;
      const totalDist = Math.sqrt(distX * distX + distY * distY);
      const velMag = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y);
      
      // Duration in frames (approx 60fps)
      // Base duration for a nice "drop" animation
      let durationFrames = 25;
      
      // If moving fast, adjust duration to maintain momentum (don't brake)
      if (velMag > 0.001) {
          const framesToCover = totalDist / velMag;
          // If the ball is moving fast enough to cover the distance quickly,
          // use a shorter duration so it doesn't look like it's slowing down.
          // We multiply by 0.9 to ensure slight acceleration (gravity).
          if (framesToCover < 30) {
              durationFrames = Math.max(10, framesToCover * 0.9);
          }
      }
      
      const ax = (2 * (distX - velocity.x * durationFrames)) / (durationFrames * durationFrames);
      const ay = (2 * (distY - velocity.y * durationFrames)) / (durationFrames * durationFrames);

      let frame = 0;
      
      const animate = () => {
        frame++;
        const t = frame;
        const progress = frame / durationFrames;
        
        // Calculate new position based on parabolic trajectory
        const curX = startX + velocity.x * t + 0.5 * ax * t * t;
        const curY = startY + velocity.y * t + 0.5 * ay * t * t;
        
        // Calculate distance to center for tipping logic
        const dx = targetX - curX;
        const dy = targetY - curY;
        const distToCenter = Math.sqrt(dx * dx + dy * dy);
        
        // Angle for rotation (align with movement or radial?)
        // Radial looks best for falling in
        const angleRad = Math.atan2(dy, dx);
        const angleDeg = angleRad * 180 / Math.PI;
        
        // Tipping Logic
        const pocketRadius = nearestPocket.radius;
        let scaleRadial = 1;
        let scaleTangential = 1;
        let opacity = 1;
        
        // Shadow Logic
        if (meta && meta.shadow) {
             // Fade shadow as we approach the edge
             const distToEdge = distToCenter - pocketRadius;
             const fadeZone = ballRadius; // Start fading 1 ball radius before edge
             
             if (distToCenter > pocketRadius) {
                 if (distToEdge < fadeZone) {
                     meta.shadow.style.opacity = String(Math.max(0, distToEdge / fadeZone));
                 } else {
                     meta.shadow.style.opacity = "1";
                 }
             } else {
                 meta.shadow.style.opacity = "0";
             }
        }

        if (distToCenter < pocketRadius) {
            // Inside the hole
            // 0 = at edge, 1 = at center
            const tipProgress = 1 - (distToCenter / pocketRadius);
            const tipEase = tipProgress * tipProgress; // Non-linear tip
            
            // Scale Radial: Foreshortening (tilting down)
            // Goes to ~0.2
            scaleRadial = 1 - tipEase * 0.85;
            
            // Scale Tangential: Perspective (falling away)
            // Goes to ~0.5
            scaleTangential = 1 - tipEase * 0.5;
            
            // Opacity
            opacity = 1 - Math.pow(tipProgress, 3);
        }
        
        group.style.opacity = String(opacity);
        
        // Transform
        // Note: We use the calculated angle to orient the squash
        group.setAttribute("transform", 
          `translate(${curX}, ${curY}) rotate(${angleDeg}) scale(${scaleRadial}, ${scaleTangential}) rotate(${-angleDeg})`
        );

        if (frame < durationFrames) {
          requestAnimationFrame(animate);
        } else {
          group.remove();
        }
      };

      requestAnimationFrame(animate);
    },
  });

  tableDriver = Driver.create<Table, Element>({
    filter: (data) => data.type == "table",
    enter: (data) => {
      const group = document.createElementNS(SVG_NS, "g");
      
      const element = document.createElementNS(SVG_NS, "rect");
      const w = data.width + data.pocketRadius * 1.5;
      const h = data.height + data.pocketRadius * 1.5;
      element.setAttribute("x", String(-w * 0.5 - STROKE_WIDTH));
      element.setAttribute("y", String(-h * 0.5 - STROKE_WIDTH));
      element.setAttribute("width", String(w + STROKE_WIDTH * 2));
      element.setAttribute("height", String(h + STROKE_WIDTH * 2));
      element.classList.add("table");
      group.appendChild(element);

      // Outer frame (slightly larger than table rectangle)
      const frame = document.createElementNS(SVG_NS, "rect");
      const framePad = data.pocketRadius * 1.8; // thickness of wood frame
      frame.setAttribute("x", String(-w * 0.5 - framePad));
      frame.setAttribute("y", String(-h * 0.5 - framePad));
      frame.setAttribute("width", String(w + framePad * 2));
      frame.setAttribute("height", String(h + framePad * 2));
      frame.classList.add("frame");
      this.frameGroup.appendChild(frame);

      // Add decorative metal dots along the rails
      const dotRadius = data.pocketRadius * 0.15;
      const railWidth = data.pocketRadius * 0.75;
      const dotOffset = railWidth * 0.5;
      
      // Positions for dots - evenly spaced along each side
      const tableW = data.width * 0.5;
      const tableH = data.height * 0.5;
      const outerW = w * 0.5;
      const outerH = h * 0.5;
      
      // Top and bottom rails - 3 dots each (avoiding pockets)
      const hDotPositions = [-tableW * 0.5, 0, tableW * 0.5];
      // Left and right rails - 2 dots each
      const vDotPositions = [-tableH * 0.35, tableH * 0.35];
      
      const addDot = (x: number, y: number) => {
        const dot = document.createElementNS(SVG_NS, "circle");
        dot.setAttribute("cx", String(x));
        dot.setAttribute("cy", String(y));
        dot.setAttribute("r", String(dotRadius));
        dot.setAttribute("fill", "url(#metal-dot)");
        dot.setAttribute("stroke", "#3a4550");
        dot.setAttribute("stroke-width", String(dotRadius * 0.15));
        group.appendChild(dot);
      };
      
      // Top rail dots
      hDotPositions.forEach(x => addDot(x, -outerH + dotOffset));
      // Bottom rail dots
      hDotPositions.forEach(x => addDot(x, outerH - dotOffset));
      // Left rail dots
      vDotPositions.forEach(y => addDot(-outerW + dotOffset, y));
      // Right rail dots
      vDotPositions.forEach(y => addDot(outerW - dotOffset, y));

      this.tableGroup.appendChild(group);
      this.handleWindowResize();
      return group;
    },
    update: (data, element) => {},
    exit: (data, element) => {
      element.remove();
    },
  });

  railDriver = Driver.create<Rail, Element>({
    filter: (data) => data.type == "rail",
    enter: (data) => {
      const element = document.createElementNS(SVG_NS, "polygon");
      element.setAttribute("points", String(data.vertices?.map((v) => `${v.x},${v.y}`).join(" ")));
      element.classList.add("rail");
      
      // Determine if rail is horizontal or vertical based on vertices
      if (data.vertices && data.vertices.length >= 2) {
        const xs = data.vertices.map(v => v.x);
        const ys = data.vertices.map(v => v.y);
        const width = Math.max(...xs) - Math.min(...xs);
        const height = Math.max(...ys) - Math.min(...ys);
        
        // If wider than tall, it's horizontal (top/bottom)
        if (width > height) {
          element.setAttribute("fill", "url(#rail-horizontal)");
        } else {
          element.setAttribute("fill", "url(#rail-vertical)");
        }
      }
      
      this.tableGroup.appendChild(element);
      return element;
    },
    update: (data, element) => {},
    exit: (data, element) => {
      element.remove();
    },
  });

  pocketDriver = Driver.create<Pocket, Element>({
    filter: (data) => data.type == "pocket",
    enter: (data) => {
      const group = document.createElementNS(SVG_NS, "g");
      
      // Determine pocket orientation and type
      let angle = 0;
      let openingHalfAngle = 0.9;
      
      // Check if side pocket (near x=0 or y=0)
      // We use a threshold relative to radius to be safe
      const threshold = data.radius; 
      
      if (Math.abs(data.position.x) < threshold) {
        // Top or Bottom Side Pocket
        // If y > 0 (Bottom), angle is PI/2 (Down). Wood Down, Opening Up.
        // If y < 0 (Top), angle is -PI/2 (Up). Wood Up, Opening Down.
        angle = data.position.y > 0 ? Math.PI / 2 : -Math.PI / 2;
        openingHalfAngle = 1.3; // Wide opening for side pockets (~150 deg)
      } else if (Math.abs(data.position.y) < threshold) {
        // Left or Right Side Pocket
        angle = data.position.x > 0 ? 0 : Math.PI;
        openingHalfAngle = 1.3;
      } else {
        // Corner Pocket - snap to nearest 45 degrees
        const x = data.position.x;
        const y = data.position.y;
        if (x > 0 && y > 0) angle = Math.PI / 4;          // Bottom-Right
        else if (x < 0 && y > 0) angle = 3 * Math.PI / 4; // Bottom-Left
        else if (x < 0 && y < 0) angle = -3 * Math.PI / 4;// Top-Left
        else angle = -Math.PI / 4;                        // Top-Right
        
        openingHalfAngle = Math.PI / 4 + 0.15; // ~54 deg half-angle (108 total)
      }

      const startAngle = angle - (Math.PI - openingHalfAngle);
      const endAngle = angle + (Math.PI - openingHalfAngle);
      
      const createSector = (r: number, fill: string, stroke?: string, strokeWidth?: string, opacity?: string) => {
        const p = document.createElementNS(SVG_NS, "path");
        const x1 = data.position.x + r * Math.cos(startAngle);
        const y1 = data.position.y + r * Math.sin(startAngle);
        const x2 = data.position.x + r * Math.cos(endAngle);
        const y2 = data.position.y + r * Math.sin(endAngle);
        
        // Large arc flag is 1 because we want the long way around (the wood part)
        const d = `M ${data.position.x} ${data.position.y} L ${x1} ${y1} A ${r} ${r} 0 1 1 ${x2} ${y2} Z`;
        
        p.setAttribute("d", d);
        p.setAttribute("fill", fill);
        if (stroke) p.setAttribute("stroke", stroke);
        if (strokeWidth) p.setAttribute("stroke-width", strokeWidth);
        if (opacity) p.setAttribute("opacity", opacity);
        return p;
      };

      // Outer wood surround (U-shaped)
      const outerWood = createSector(
        data.radius * 1.25, 
        "url(#frame-wood)", 
        "#2a1a0a", 
        String(data.radius * 0.08)
      );
      group.appendChild(outerWood);

      // Main pocket hole
      const element = document.createElementNS(SVG_NS, "circle");
      element.setAttribute("cx", String(data.position.x));
      element.setAttribute("cy", String(data.position.y));
      element.setAttribute("r", String(data.radius));
      element.classList.add("pocket");
      group.appendChild(element);

      this.tableGroup.appendChild(group);
      return group;
    },
    update: (data, element) => {},
    exit: (data, element) => {
      element.remove();
    },
  });

  cueDriver = Driver.create<CueStick, Element>({
    filter: (data) => data.type == "cue",
    enter: (data) => {
      const group = document.createElementNS(SVG_NS, "g");
      group.classList.add("cue-group");
      
      // Guide line (Solid) - simple straight line from cue ball
      const guideLine = document.createElementNS(SVG_NS, "line");
      guideLine.classList.add("guide-line");
      guideLine.setAttribute("stroke", "white");
      guideLine.setAttribute("stroke-width", "0.006");
      guideLine.setAttribute("opacity", "0.7");
      group.appendChild(guideLine);
      
      // Guide path (for bounces) - polyline showing cue ball trajectory
      const guidePath = document.createElementNS(SVG_NS, "polyline");
      guidePath.classList.add("guide-path");
      guidePath.setAttribute("stroke", "white");
      guidePath.setAttribute("stroke-width", "0.006");
      guidePath.setAttribute("fill", "none");
      guidePath.setAttribute("opacity", "0.7");
      guidePath.style.display = "none";
      group.appendChild(guidePath);

      // Target Path Line (Direction hit ball will go)
      const targetLine = document.createElementNS(SVG_NS, "line");
      targetLine.classList.add("target-line");
      targetLine.setAttribute("stroke", "white");
      targetLine.setAttribute("stroke-width", "0.006");
      targetLine.setAttribute("opacity", "0.7");
      targetLine.style.display = "none";
      group.appendChild(targetLine);

      // Deflection Path Line (Direction cue ball will go)
      const deflectLine = document.createElementNS(SVG_NS, "line");
      deflectLine.classList.add("deflect-line");
      deflectLine.setAttribute("stroke", "white");
      deflectLine.setAttribute("stroke-width", "0.005");
      deflectLine.setAttribute("opacity", "0.5");
      deflectLine.style.display = "none";
      group.appendChild(deflectLine);
      
      const shadow = document.createElementNS(SVG_NS, "line");
      shadow.classList.add("cue-shadow");
      shadow.setAttribute("stroke", "rgba(0,0,0,0.3)");
      shadow.setAttribute("stroke-width", "0.014");
      shadow.setAttribute("stroke-linecap", "round");
      group.appendChild(shadow);
      
      const butt = document.createElementNS(SVG_NS, "line");
      butt.classList.add("cue-butt");
      butt.setAttribute("stroke", "#4a3728");
      butt.setAttribute("stroke-width", "0.018");
      butt.setAttribute("stroke-linecap", "round");
      group.appendChild(butt);
      
      const wrap = document.createElementNS(SVG_NS, "line");
      wrap.classList.add("cue-wrap");
      wrap.setAttribute("stroke", "#1a1a1a");
      wrap.setAttribute("stroke-width", "0.016");
      wrap.setAttribute("stroke-linecap", "butt");
      group.appendChild(wrap);
      
      const shaft = document.createElementNS(SVG_NS, "line");
      shaft.classList.add("cue-shaft");
      shaft.setAttribute("stroke", "#deb887");
      shaft.setAttribute("stroke-width", "0.013");
      shaft.setAttribute("stroke-linecap", "butt");
      group.appendChild(shaft);
      
      const ferrule = document.createElementNS(SVG_NS, "line");
      ferrule.classList.add("cue-ferrule");
      ferrule.setAttribute("stroke", "#f0f0f0");
      ferrule.setAttribute("stroke-width", "0.012");
      ferrule.setAttribute("stroke-linecap", "butt");
      group.appendChild(ferrule);
      
      const tip = document.createElementNS(SVG_NS, "circle");
      tip.classList.add("cue-tip");
      tip.setAttribute("r", "0.007");
      group.appendChild(tip);

      // Ghost Ball (Impact Indicator)
      const ghostBall = document.createElementNS(SVG_NS, "circle");
      ghostBall.classList.add("ghost-ball");
      ghostBall.setAttribute("r", "0.01"); // Will be updated to match ball radius
      ghostBall.setAttribute("fill", "none");
      ghostBall.setAttribute("stroke", "white");
      ghostBall.setAttribute("stroke-width", "0.004");
      ghostBall.setAttribute("stroke-dasharray", "0.008, 0.006");
      ghostBall.setAttribute("opacity", "0.8");
      ghostBall.style.display = "none";
      group.appendChild(ghostBall);
      
      // Cache element references to avoid querySelector each frame
      // Dev prediction markers
      const predictionDot = document.createElementNS(SVG_NS, "circle");
      predictionDot.classList.add("prediction-dot");
      predictionDot.setAttribute("r", "0.015");
      predictionDot.setAttribute("fill", "#ff00ff");
      predictionDot.setAttribute("stroke", "white");
      predictionDot.setAttribute("stroke-width", "0.003");
      predictionDot.style.display = "none";
      group.appendChild(predictionDot);
      
      const predictionTargetDot = document.createElementNS(SVG_NS, "circle");
      predictionTargetDot.classList.add("prediction-target-dot");
      predictionTargetDot.setAttribute("r", "0.012");
      predictionTargetDot.setAttribute("fill", "#00ffff");
      predictionTargetDot.setAttribute("stroke", "white");
      predictionTargetDot.setAttribute("stroke-width", "0.002");
      predictionTargetDot.style.display = "none";
      group.appendChild(predictionTargetDot);
      
      // Hacker mode elements
      const hackerTargetPath = document.createElementNS(SVG_NS, "polyline");
      hackerTargetPath.classList.add("hacker-target-path");
      hackerTargetPath.setAttribute("stroke", "#00ff00");
      hackerTargetPath.setAttribute("stroke-width", "0.006");
      hackerTargetPath.setAttribute("fill", "none");
      hackerTargetPath.setAttribute("opacity", "0.9");
      hackerTargetPath.setAttribute("stroke-dasharray", "0.012, 0.006");
      hackerTargetPath.style.display = "none";
      group.appendChild(hackerTargetPath);
      
      const hackerInLabel = document.createElementNS(SVG_NS, "text");
      hackerInLabel.classList.add("hacker-in-label");
      hackerInLabel.setAttribute("font-family", "Courier New, monospace");
      hackerInLabel.setAttribute("font-size", "0.05");
      hackerInLabel.setAttribute("font-weight", "bold");
      hackerInLabel.setAttribute("text-anchor", "middle");
      hackerInLabel.style.display = "none";
      group.appendChild(hackerInLabel);
      
      (group as any).__cueElements = { shadow, butt, wrap, shaft, ferrule, tip, guideLine, guidePath, ghostBall, targetLine, deflectLine, predictionDot, predictionTargetDot, hackerTargetPath, hackerInLabel };
      
      this.cueGroup.appendChild(group);
      return group;
    },
    update: (data, element) => {
      const cached = (element as any).__cueElements;
      if (!cached) return;
      
      const { shadow, butt, wrap, shaft, ferrule, tip, guideLine, guidePath, ghostBall, targetLine, deflectLine, predictionDot, predictionTargetDot, hackerTargetPath, hackerInLabel } = cached;
      
      // start = cue ball position, end = opposite side of where ball will go
      // The ball shoots AWAY from cue.end, so the cue tip should be OPPOSITE to cue.end
      const ballX = data.start.x;
      const ballY = data.start.y;
      const endX = data.end.x;
      const endY = data.end.y;
      
      // Direction from end toward ball (this points toward where ball will go)
      // Cue should be on the OPPOSITE side, so we flip it
      const dx = ballX - endX;
      const dy = ballY - endY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      // Hide if distance too small
      if (dist < 0.005) {
        (element as SVGElement).style.display = "none";
        return;
      }
      (element as SVGElement).style.display = "";
      
      // Normalized direction (pointing from ball AWAY from cue.end = toward shot direction)
      // Cue tip is on opposite side, so we use negative direction
      const nx = -dx / dist;
      const ny = -dy / dist;

      // --- Guide Line Raycast ---
      // Shot direction is (nx, ny) * -1 = (dx/dist, dy/dist)
      // Wait, nx is -dx/dist. So shot direction is -nx, -ny.
      // Let's re-verify:
      // cue.end is handle. cue.start is ball.
      // Vector from handle to ball is (start - end) = (dx, dy).
      // This is the direction the stick is pointing.
      // So shot direction is (dx, dy) normalized.
      const shotDx = dx / dist;
      const shotDy = dy / dist;

      let hitDist = 2.0; // Max length
      let hitBallRadius = 0;
      let hitType = 'none';
      let hitBallPos = { x: 0, y: 0 };
      let hitBallColor = ''; // Track the color of the hit ball
      let hitBallKey = ''; // Track the key of the hit ball for prediction tracking

      // Get cue ball radius for wall collision offset
      const cueBallRadiusForWall = data.ball?.radius || 0.031;

      // 1. Check Walls (account for ball radius - ball stops when edge touches wall)
      const table = this.context.table;
      if (table) {
        const w = table.width / 2;
        const h = table.height / 2;
        // Ray: O + tD.
        // Ball center stops at (w - r) or (-w + r) etc.
        
        if (shotDx > 0.0001) {
           const t = (w - cueBallRadiusForWall - ballX) / shotDx;
           if (t > 0 && t < hitDist) { hitDist = t; hitType = 'wall'; }
        } else if (shotDx < -0.0001) {
           const t = (-w + cueBallRadiusForWall - ballX) / shotDx;
           if (t > 0 && t < hitDist) { hitDist = t; hitType = 'wall'; }
        }
        
        if (shotDy > 0.0001) {
           const t = (h - cueBallRadiusForWall - ballY) / shotDy;
           if (t > 0 && t < hitDist) { hitDist = t; hitType = 'wall'; }
        } else if (shotDy < -0.0001) {
           const t = (-h + cueBallRadiusForWall - ballY) / shotDy;
           if (t > 0 && t < hitDist) { hitDist = t; hitType = 'wall'; }
        }
      }

      // 2. Check Balls - find all potential hits, then select based on lookup data availability
      // We collect all balls that COULD be hit, sorted by distance
      // Then we check if we have physics lookup data for each one
      // If not, we skip to the next ball (the shot wouldn't reliably hit at this power)
      type PotentialHit = {
        dist: number;
        ball: typeof this.context.balls[0];
        cutAngleDeg: number;
        ghostX: number;
        ghostY: number;
      };
      const potentialBallHits: PotentialHit[] = [];
      
      // Get current shot power for lookup data check
      const currentShotPower = (this.currentPower && this.currentPower > 0.01) ? this.currentPower : 0.5;
      
      if (this.context.balls && data.ball) {
        const cueBallRadius = data.ball.radius;

        for (const otherBall of this.context.balls) {
          if (otherBall.key === data.ball.key) continue; // Skip cue ball
          
          // Use actual radii sum for collision distance
          const targetRadius = otherBall.radius;
          const baseCombinedRadius = cueBallRadius + targetRadius;
          
          // Vector to ball center
          const vx = otherBall.position.x - ballX;
          const vy = otherBall.position.y - ballY;
          
          // Distance to ball center squared
          const distSq = vx * vx + vy * vy;
          
          // Skip if we're essentially overlapping
          if (distSq < 0.0001) continue;
          
          // Project onto ray (t = distance along ray to closest approach point)
          const t = vx * shotDx + vy * shotDy;
          
          // Use full combined radius for geometric hit detection
          const combinedRadiusSq = baseCombinedRadius * baseCombinedRadius;
          
          // Distance squared from infinite line to ball center
          const dSq = distSq - (t * t);
          
          // Check if ray passes close enough to hit the ball
          if (dSq < combinedRadiusSq) {
            // It's a geometric hit! Calculate entry point
            const dt = Math.sqrt(combinedRadiusSq - dSq);
            const tEntry = t - dt;
            const tExit = t + dt;
            
            if (tExit > 0) {
              const effectiveHitDist = Math.max(0.001, tEntry);
              
              // Calculate ghost ball position (cue ball at moment of contact)
              const ghostX = ballX + shotDx * effectiveHitDist;
              const ghostY = ballY + shotDy * effectiveHitDist;
              
              // Calculate cut angle for this potential hit
              const toTargetX = otherBall.position.x - ghostX;
              const toTargetY = otherBall.position.y - ghostY;
              const toTargetLen = Math.sqrt(toTargetX * toTargetX + toTargetY * toTargetY);
              
              if (toTargetLen > 0.0001) {
                const baseTargetDirX = toTargetX / toTargetLen;
                const baseTargetDirY = toTargetY / toTargetLen;
                const momentumTransfer = Math.abs(shotDx * baseTargetDirX + shotDy * baseTargetDirY);
                const cutAngleRad = Math.acos(Math.max(-1, Math.min(1, momentumTransfer)));
                const crossProduct = shotDx * baseTargetDirY - shotDy * baseTargetDirX;
                const cutAngleDeg = (crossProduct >= 0 ? -1 : 1) * cutAngleRad * 180 / Math.PI;
                
                potentialBallHits.push({
                  dist: effectiveHitDist,
                  ball: otherBall,
                  cutAngleDeg,
                  ghostX,
                  ghostY
                });
              }
            }
          }
        }
      }
      
      // Sort by distance (closest first)
      potentialBallHits.sort((a, b) => a.dist - b.dist);
      
      // Find the first ball that has valid lookup data for this power
      // If no ball has data, we'll hit the wall instead
      let selectedBallHit: PotentialHit | null = null;
      for (const hit of potentialBallHits) {
        // Check if we have lookup data for this angle/power
        const lookupResult = lookupPhysicsPrediction(hit.cutAngleDeg, currentShotPower);
        if (lookupResult) {
          // We have valid physics data for this shot
          selectedBallHit = hit;
          break;
        }
        // No data for this ball at this power - skip to next ball
      }
      
      // Apply the selected ball hit (or keep wall if no valid ball hit)
      if (selectedBallHit && selectedBallHit.dist < hitDist) {
        hitDist = selectedBallHit.dist;
        hitBallRadius = selectedBallHit.ball.radius;
        hitType = 'ball';
        hitBallPos = selectedBallHit.ball.position;
        hitBallColor = selectedBallHit.ball.color;
        hitBallKey = selectedBallHit.ball.key;
      }

      let guideEndX = ballX + shotDx * hitDist;
      let guideEndY = ballY + shotDy * hitDist;

      // Determine line color based on ball ownership
      let lineColor = 'white'; // Default/wall
      let lineOpacity = '0.5';
      
      if (hitType === 'ball' && hitBallColor) {
        // Get current player's color assignment
        const players = this.context.players;
        const turn = this.context.turn;
        const currentPlayer = players?.find(p => p.turn === turn?.current);
        const playerColor = currentPlayer?.color; // 'solid' or 'stripe'
        
        if (hitBallColor === 'black') {
          // 8-ball: yellow/gold (special)
          lineColor = '#f5a623';
          lineOpacity = '0.7';
        } else if (!playerColor) {
          // Colors not assigned yet - neutral white
          lineColor = 'white';
          lineOpacity = '0.5';
        } else {
          // Check if this ball belongs to current player
          const isSolid = hitBallColor.endsWith('-solid');
          const isStripe = hitBallColor.endsWith('-stripe');
          const isOwnBall = (playerColor === 'solid' && isSolid) || (playerColor === 'stripe' && isStripe);
          
          if (isOwnBall) {
            lineColor = '#4caf50'; // Green - your ball
            lineOpacity = '0.7';
          } else {
            lineColor = '#f44336'; // Red - opponent's ball
            lineOpacity = '0.7';
          }
        }
      }
      
      // --- RUN PHYSICS SIMULATION FIRST ---
      // This overrides the raycast results with actual physics predictions
      // Use a very small threshold for smooth updates (0.0001 = 0.01% change triggers update)
      const aimChanged = 
        Math.abs(shotDx - this.predictionCache.lastShotDirX) > 0.0001 ||
        Math.abs(shotDy - this.predictionCache.lastShotDirY) > 0.0001 ||
        Math.abs(ballX - this.predictionCache.lastCuePosX) > 0.0001 ||
        Math.abs(ballY - this.predictionCache.lastCuePosY) > 0.0001;
      
      if (aimChanged && !this.context.shotInProgress) {
        const simResult = this.simulateShot({ x: shotDx, y: shotDy }, 1.0);
        this.predictionCache = {
          ...simResult,
          lastShotDirX: shotDx,
          lastShotDirY: shotDy,
          lastCuePosX: ballX,
          lastCuePosY: ballY,
        };
      }
      
      // Determine what the FIRST thing hit is: wall or ball
      // The raycast already calculated this correctly - it traces a straight line
      // If raycast says 'wall', there's no ball DIRECTLY in the path, so show wall
      // Only use simulation's ball hit if raycast ALSO found a ball (for more accurate position)
      
      const raycastHitType = hitType; // Save original raycast result
      const raycastGuideEndX = guideEndX;
      const raycastGuideEndY = guideEndY;
      
      // Trust the raycast for hit detection AND position - it's geometrically accurate
      // Raycast calculates exact contact point, simulation hitPoint is AFTER physics overlap
      // Keep ALL raycast values (hitBallKey, hitBallPos, guideEndX/Y) - don't override with simulation
      // Only use simulation for target ball PATH (after the hit) and pocket prediction
      
      // Calculate target ball direction geometrically from ghost ball position to target ball center
      // This is the direction the target ball will travel after being hit
      // Also calculate momentum transfer factor (0 to 1) based on hit fullness
      let geometricTargetDir: { x: number; y: number } | null = null;
      let momentumTransfer = 0; // 0 = thin cut (glancing), 1 = full hit (direct)
      
      // currentShotPower already defined above in ball detection section
      
      if (raycastHitType === 'ball' && hitBallPos) {
        // Direction from ghost ball (cue ball at impact) to target ball center
        const toTargetX = hitBallPos.x - guideEndX;
        const toTargetY = hitBallPos.y - guideEndY;
        const toTargetLen = Math.sqrt(toTargetX * toTargetX + toTargetY * toTargetY);
        if (toTargetLen > 0.0001) {
          // Base geometric direction (collision normal)
          const baseTargetDirX = toTargetX / toTargetLen;
          const baseTargetDirY = toTargetY / toTargetLen;
          
          // Momentum transfer = dot product of shot direction and hit direction
          // This gives cos(angle) between shot line and line to target center
          // 1.0 = direct hit (100% momentum to target)
          // 0.0 = 90� cut (minimal momentum to target)
          momentumTransfer = Math.abs(shotDx * baseTargetDirX + shotDy * baseTargetDirY);
          
          // Calculate cut angle in degrees for lookup table
          // Cut angle = angle between shot direction and collision normal
          // In collision-test: positive angle means ghost ball is ABOVE the shot line
          // which means target ball is BELOW and to the right of the ghost ball position
          const cutAngleRad = Math.acos(Math.max(-1, Math.min(1, momentumTransfer)));
          // Determine sign based on which side of the shot line the target ball is
          // Cross product of (shot dir) × (ghost-to-target) tells us the side
          // We need NEGATIVE of this because:
          // - When ghost is above target (positive cut in test), baseTargetDirY is negative
          // - Cross product gives negative, but we want positive
          const crossProduct = shotDx * baseTargetDirY - shotDy * baseTargetDirX;
          const cutAngleDeg = (crossProduct >= 0 ? -1 : 1) * cutAngleRad * 180 / Math.PI;
          
          // ========== LOOKUP TABLE PREDICTION ==========
          // Use pre-computed actual physics angles from Planck.js simulation
          // The lookup table was built with shot direction along +X axis
          // So lookup vectors need to be rotated by the actual shot angle
          // NOTE: We already verified lookup data exists in the raycast phase,
          // so lookupResult should always be valid here
          const lookupResult = lookupPhysicsPrediction(cutAngleDeg, currentShotPower);
          
          // Get shot angle (angle of shot direction from +X axis)
          const shotAngleRad = Math.atan2(shotDy, shotDx);
          const cosShot = Math.cos(shotAngleRad);
          const sinShot = Math.sin(shotAngleRad);
          
          if (lookupResult && Math.abs(cutAngleDeg) > 1) {
            // Rotate the lookup unit vectors by the shot angle
            // Lookup vectors are in a coordinate system where shot is along +X
            // Rotate (tx, ty) by shotAngleRad to get actual target direction
            geometricTargetDir = {
              x: lookupResult.tx * cosShot - lookupResult.ty * sinShot,
              y: lookupResult.tx * sinShot + lookupResult.ty * cosShot
            };
          } else {
            // Very small cut angle or lookup unavailable - use base geometric
            geometricTargetDir = { x: baseTargetDirX, y: baseTargetDirY };
          }
        }
      }
      
      if (raycastHitType === 'wall') {
        // Raycast hit wall - no ball directly in path, show wall
        hitType = 'wall';
        lineColor = 'white';
        lineOpacity = '0.3';
      }
      // If raycast hit a ball, keep all the raycast values (already set correctly above)
      
      // Save the guide's prediction for verification after the shot
      // This captures what the visual guide is showing to the user
      if (!this.context.shotInProgress) {
        this.lastPrediction.guideHitType = hitType;
        this.lastPrediction.guideHitBallKey = hitType === 'ball' ? hitBallKey : null;
      }
      
      // Check if hacker mode is active for this player
      const currentTurn = this.context.turn?.current;
      const isHackerPlayer = this.hackerMode && this.hackerModePlayer === currentTurn;
      
      const DIRECTION_LINE_LENGTH = 0.15; // Length of direction indicator lines
      const cueBallRadius = data.ball?.radius || 0.031;
      // Ghost ball visual radius matches the ball's visible size (physics radius minus stroke width)
      const ghostBallVisualRadius = cueBallRadius - STROKE_WIDTH;
      
      if (isHackerPlayer) {
        // ========== HACKER MODE ==========
        // Use full simulation results, show paths with bounces, "IN!" indicator
        // NOTE: guideEndX/Y already set correctly by raycast above - don't override with simulation's hitPoint
        
        // Draw cue ball path with bounces if available
        const cuePath = this.predictionCache.cueBallPath;
        if (cuePath && cuePath.length > 2) {
          guideLine.style.display = "none";
          guidePath.style.display = "";
          guidePath.setAttribute("stroke", lineColor);
          guidePath.setAttribute("opacity", lineOpacity);
          // Use simulation path but replace the last point with the geometrically correct ghost ball position
          const pathPoints = cuePath.slice(0, -1); // All points except last
          pathPoints.push({ x: guideEndX, y: guideEndY }); // Add correct endpoint
          const points = pathPoints.map(p => `${p.x},${p.y}`).join(' ');
          guidePath.setAttribute("points", points);
        } else {
          guidePath.style.display = "none";
          guideLine.style.display = "";
          guideLine.setAttribute("stroke", lineColor);
          guideLine.setAttribute("opacity", lineOpacity);
          guideLine.setAttribute("x1", String(ballX));
          guideLine.setAttribute("y1", String(ballY));
          guideLine.setAttribute("x2", String(guideEndX));
          guideLine.setAttribute("y2", String(guideEndY));
        }
        
        // Show target ball full path - start from actual ball center
        const targetPath = this.predictionCache.targetBallPath;
        if (hitType === 'ball' && targetPath && targetPath.length > 1 && hitBallPos) {
          hackerTargetPath.style.display = "";
          // Replace first point with actual ball center position (simulation position may be off)
          const correctedPath = [hitBallPos, ...targetPath.slice(1)];
          const points = correctedPath.map(p => `${p.x},${p.y}`).join(' ');
          hackerTargetPath.setAttribute("points", points);
          hackerTargetPath.setAttribute("stroke", lineColor);
          hackerTargetPath.setAttribute("opacity", "0.6");
          hackerTargetPath.setAttribute("stroke-dasharray", "0.008, 0.004");
        } else {
          hackerTargetPath.style.display = "none";
        }
        
        // Ghost ball at collision point
        if (hitType === 'ball') {
          ghostBall.style.display = "";
          ghostBall.setAttribute("cx", String(guideEndX));
          ghostBall.setAttribute("cy", String(guideEndY));
          ghostBall.setAttribute("r", String(ghostBallVisualRadius));
          ghostBall.setAttribute("stroke", lineColor);
        } else {
          ghostBall.style.display = "none";
        }
        
        // "IN!" indicator for pocketable shots
        if (this.predictionCache.willPocket && this.predictionCache.targetBallPos) {
          hackerInLabel.style.display = "";
          const labelX = this.predictionCache.targetBallPos.x;
          const labelY = this.predictionCache.targetBallPos.y - 0.06;
          hackerInLabel.setAttribute("x", String(labelX));
          hackerInLabel.setAttribute("y", String(labelY));
          hackerInLabel.textContent = "?? IN!";
          hackerInLabel.setAttribute("fill", "#00ff00");
          hackerInLabel.setAttribute("stroke", "#003300");
          hackerInLabel.setAttribute("stroke-width", "0.002");
        } else {
          hackerInLabel.style.display = "none";
        }
        
        targetLine.style.display = "none";
        deflectLine.style.display = "none";
        
      } else {
        // ========== NORMAL MODE ==========
        // Simple guides - line to first wall/ball, ghost circle, immediate directions only
        // Only show ball hit prediction if we have valid lookup data for this power level
        
        guidePath.style.display = "none"; // Never use polyline for normal mode
        guideLine.style.display = "";
        guideLine.setAttribute("stroke", lineColor);
        guideLine.setAttribute("opacity", lineOpacity);
        guideLine.setAttribute("x1", String(ballX));
        guideLine.setAttribute("y1", String(ballY));
        hackerInLabel.style.display = "none";
        
        // Ball hits are only accepted if lookup data exists (checked in raycast phase)
        if (hitType === 'ball') {
          // Hitting a ball directly and we have physics data
          guideLine.setAttribute("x2", String(guideEndX));
          guideLine.setAttribute("y2", String(guideEndY));
          
          // Ghost ball at impact point
          ghostBall.style.display = "";
          ghostBall.setAttribute("cx", String(guideEndX));
          ghostBall.setAttribute("cy", String(guideEndY));
          ghostBall.setAttribute("r", String(ghostBallVisualRadius));
          ghostBall.setAttribute("stroke", lineColor);
          
          // Target ball direction - use GEOMETRIC direction (always correct for immediate hit)
          // but use simulation SPEED for line length (accurate momentum)
          // Simulation direction can be wrong if ball bounces before we detect it
          const simTargetSpeed = this.predictionCache.targetBallSpeed;
          const simCueSpeed = this.predictionCache.cueBallSpeedAfterHit;
          
          // Normalize speeds to a reasonable line length (speeds are typically 0-2 range)
          const MAX_SPEED_FOR_LINE = 1.5; // Speed at which line is at full length
          
          if (geometricTargetDir && hitBallPos) {
            // Use geometric direction (ghost ball ? target center = immediate hit direction)
            // Use simulation speed for line length (accurate momentum transfer)
            const speedFactor = simTargetSpeed > 0.001 
              ? Math.min(1, simTargetSpeed / MAX_SPEED_FOR_LINE)
              : 0.5; // Default if no simulation
            const targetLineLength = DIRECTION_LINE_LENGTH * (0.15 + 0.85 * speedFactor);
            targetLine.style.display = "";
            targetLine.setAttribute("stroke", lineColor);
            targetLine.setAttribute("opacity", "0.6");
            targetLine.setAttribute("x1", String(hitBallPos.x));
            targetLine.setAttribute("y1", String(hitBallPos.y));
            targetLine.setAttribute("x2", String(hitBallPos.x + geometricTargetDir.x * targetLineLength));
            targetLine.setAttribute("y2", String(hitBallPos.y + geometricTargetDir.y * targetLineLength));
          } else {
            targetLine.style.display = "none";
          }
          
          // Cue ball deflection - using lookup table for physics-accurate prediction
          if (geometricTargetDir) {
            // Calculate cut angle for lookup
            const toTargetX = hitBallPos.x - guideEndX;
            const toTargetY = hitBallPos.y - guideEndY;
            const toTargetLen = Math.sqrt(toTargetX * toTargetX + toTargetY * toTargetY);
            const baseNormalX = toTargetLen > 0.0001 ? toTargetX / toTargetLen : geometricTargetDir.x;
            const baseNormalY = toTargetLen > 0.0001 ? toTargetY / toTargetLen : geometricTargetDir.y;
            
            // Calculate cut angle for lookup table (same sign convention as target ball)
            const dotProduct = shotDx * baseNormalX + shotDy * baseNormalY;
            const cutAngleRad = Math.acos(Math.max(-1, Math.min(1, Math.abs(dotProduct))));
            const crossProduct = shotDx * baseNormalY - shotDy * baseNormalX;
            const cutAngleDeg = (crossProduct >= 0 ? -1 : 1) * cutAngleRad * 180 / Math.PI;
            
            // Look up cue ball deflection direction from physics table
            const lookupResult = lookupPhysicsPrediction(cutAngleDeg, currentShotPower);
            
            // Get shot angle for coordinate transformation
            const shotAngleRad = Math.atan2(shotDy, shotDx);
            const cosShot = Math.cos(shotAngleRad);
            const sinShot = Math.sin(shotAngleRad);
            
            let deflectDirX: number, deflectDirY: number;
            
            if (lookupResult && Math.abs(cutAngleDeg) > 1) {
              // Rotate the lookup cue direction vector by the shot angle
              // (cx, cy) is the cue ball direction in the coordinate system where shot is along +X
              deflectDirX = lookupResult.cx * cosShot - lookupResult.cy * sinShot;
              deflectDirY = lookupResult.cx * sinShot + lookupResult.cy * cosShot;
            } else {
              // Near-direct hit: cue ball continues in shot direction (or use geometric fallback)
              if (Math.abs(cutAngleDeg) < 1) {
                deflectDirX = shotDx;
                deflectDirY = shotDy;
              } else {
                // Fallback to geometric calculation
                deflectDirX = shotDx - dotProduct * baseNormalX;
                deflectDirY = shotDy - dotProduct * baseNormalY;
                const deflectLen = Math.sqrt(deflectDirX * deflectDirX + deflectDirY * deflectDirY);
                if (deflectLen > 0.001) {
                  deflectDirX /= deflectLen;
                  deflectDirY /= deflectLen;
                } else {
                  deflectDirX = shotDx;
                  deflectDirY = shotDy;
                }
              }
            }
            
            // Line length based on cut angle (more cut = longer deflection line)
            const geomDeflectLen = Math.sqrt(
              (shotDx - dotProduct * baseNormalX) ** 2 + 
              (shotDy - dotProduct * baseNormalY) ** 2
            );
            const deflectLineLength = DIRECTION_LINE_LENGTH * (0.15 + 0.85 * geomDeflectLen);
            
            deflectLine.style.display = "";
            deflectLine.setAttribute("stroke", lineColor);
            deflectLine.setAttribute("opacity", "0.4");
            deflectLine.setAttribute("x1", String(guideEndX));
            deflectLine.setAttribute("y1", String(guideEndY));
            deflectLine.setAttribute("x2", String(guideEndX + deflectDirX * deflectLineLength));
            deflectLine.setAttribute("y2", String(guideEndY + deflectDirY * deflectLineLength));
          } else {
            deflectLine.style.display = "none";
          }
          
          hackerTargetPath.style.display = "none";
          
        } else if (hitType === 'wall') {
          // Hitting a wall (no ball in direct path)
          guideLine.setAttribute("x2", String(guideEndX));
          guideLine.setAttribute("y2", String(guideEndY));
          
          // Ghost ball at wall hit point
          ghostBall.style.display = "";
          ghostBall.setAttribute("cx", String(guideEndX));
          ghostBall.setAttribute("cy", String(guideEndY));
          ghostBall.setAttribute("r", String(ghostBallVisualRadius));
          ghostBall.setAttribute("stroke", lineColor);
          
          // Calculate reflection direction
          let reflectDirX = shotDx;
          let reflectDirY = shotDy;
          
          const wallBounce = this.predictionCache.firstWallBounce;
          if (wallBounce && wallBounce.dirAfter) {
            reflectDirX = wallBounce.dirAfter.x;
            reflectDirY = wallBounce.dirAfter.y;
          } else {
            const table = this.context.table;
            if (table) {
              const w = table.width / 2;
              const h = table.height / 2;
              const distToRight = Math.abs(guideEndX - w);
              const distToLeft = Math.abs(guideEndX + w);
              const distToTop = Math.abs(guideEndY - h);
              const distToBottom = Math.abs(guideEndY + h);
              const minXDist = Math.min(distToRight, distToLeft);
              const minYDist = Math.min(distToTop, distToBottom);
              if (minXDist < minYDist) {
                reflectDirX = -shotDx;
              } else {
                reflectDirY = -shotDy;
              }
            }
          }
          
          // Direction after bounce
          deflectLine.style.display = "";
          deflectLine.setAttribute("stroke", lineColor);
          deflectLine.setAttribute("opacity", "0.4");
          deflectLine.setAttribute("x1", String(guideEndX));
          deflectLine.setAttribute("y1", String(guideEndY));
          deflectLine.setAttribute("x2", String(guideEndX + reflectDirX * DIRECTION_LINE_LENGTH));
          deflectLine.setAttribute("y2", String(guideEndY + reflectDirY * DIRECTION_LINE_LENGTH));
          
          targetLine.style.display = "none";
          hackerTargetPath.style.display = "none";
          
        } else {
          // No collision detected
          guideLine.setAttribute("x2", String(guideEndX));
          guideLine.setAttribute("y2", String(guideEndY));
          ghostBall.style.display = "none";
          targetLine.style.display = "none";
          deflectLine.style.display = "none";
          hackerTargetPath.style.display = "none";
        }
      }

      // Store prediction data for debugging
      if (hitType === 'ball' && hitBallPos) {
        const nx = hitBallPos.x - guideEndX;
        const ny = hitBallPos.y - guideEndY;
        const nLen = Math.sqrt(nx * nx + ny * ny);
        
        if (nLen > 0.0001) {
            let normX = nx / nLen;
            let normY = ny / nLen;
            
            if (this.predictionCache.targetBallDir) {
              normX = this.predictionCache.targetBallDir.x;
              normY = this.predictionCache.targetBallDir.y;
            }

            if (!this.lastPrediction.locked) {
               this.lastPrediction.rawTargetDir = { x: nx / nLen, y: ny / nLen };
               this.lastPrediction.predictedTargetDir = { x: normX, y: normY };
               this.lastPrediction.shotDir = { x: shotDx, y: shotDy };
            }
        }
      }
      
      // Dev Prediction Display - shows where balls will end up after collision
      // Uses physics-based stopping distance calculation with linear damping
      if (this.showDevPrediction) {
        const table = this.context.table;
        
        // Physics constants (matching Physics.ts)
        const LINEAR_DAMPING = 2.2;
        const BALL_RESTITUTION = 0.99;
        const RAIL_RESTITUTION = 0.9;
        const MAX_FORCE = 0.06;
        const BALL_RADIUS = data.ball?.radius || 0.031;
        const BALL_MASS = Math.PI * BALL_RADIUS * BALL_RADIUS; // density = 1
        
        // Calculate initial velocity from power
        // impulse = power * maxForce, velocity = impulse / mass
        // If power is 0 (aiming), assume full power for prediction visualization
        const power = (this.currentPower && this.currentPower > 0.01) ? this.currentPower : 1.0;
        const impulse = power * MAX_FORCE;
        const initialVelocity = impulse / BALL_MASS;
        
        // Stopping distance = v0 / damping (for exponential damping)
        const maxTravelDistance = initialVelocity / LINEAR_DAMPING;
        
        if (hitType === 'ball') {
          // Calculate cue ball deflection direction (same math as deflection line)
          const impactNx = hitBallPos.x - guideEndX;
          const impactNy = hitBallPos.y - guideEndY;
          const impactNLen = Math.sqrt(impactNx * impactNx + impactNy * impactNy);
          
          if (impactNLen > 0.0001) {
            let normX = impactNx / impactNLen;
            let normY = impactNy / impactNLen;
            
            // Store raw normal for logging
            const rawNormX = normX;
            const rawNormY = normY;
            
            // For equal mass elastic collision:
            // Cue ball transfers normal component to target ball
            // Cue ball keeps tangential component
            const vDotN = shotDx * normX + shotDy * normY; // Component along collision normal
            
            // No throw correction - use pure geometric normal
            // The physics engine's friction (0.1) produces minimal throw
            
            // Energy transferred to target ball (proportional to vDotN^2)
            // For equal mass elastic collision: target gets vDotN, cue keeps tangent
            const targetVelocityMag = Math.abs(vDotN) * initialVelocity;
            const cueRemainingVelocityMag = Math.sqrt(1 - vDotN * vDotN) * initialVelocity;
            
            // Stopping distances for each ball
            const targetStopDist = targetVelocityMag / LINEAR_DAMPING;
            const cueStopDist = cueRemainingVelocityMag / LINEAR_DAMPING;
            
            // Cue ball deflection direction (perpendicular to collision normal)
            // tangent = shot - (shot � norm) * norm
            const tangentX = shotDx - vDotN * normX;
            const tangentY = shotDy - vDotN * normY;
            const tangentLen = Math.sqrt(tangentX * tangentX + tangentY * tangentY);
            
            if (tangentLen > 0.001 && cueStopDist > 0.01 && table) {
              const deflectDirX = tangentX / tangentLen;
              const deflectDirY = tangentY / tangentLen;
              
              const w = table.width / 2;
              const h = table.height / 2;
              
              // Check if cue ball hits wall before stopping
              let wallDist = cueStopDist;
              if (deflectDirX > 0.0001) {
                const t = (w - BALL_RADIUS - guideEndX) / deflectDirX;
                if (t > 0 && t < wallDist) wallDist = t;
              } else if (deflectDirX < -0.0001) {
                const t = (-w + BALL_RADIUS - guideEndX) / deflectDirX;
                if (t > 0 && t < wallDist) wallDist = t;
              }
              if (deflectDirY > 0.0001) {
                const t = (h - BALL_RADIUS - guideEndY) / deflectDirY;
                if (t > 0 && t < wallDist) wallDist = t;
              } else if (deflectDirY < -0.0001) {
                const t = (-h + BALL_RADIUS - guideEndY) / deflectDirY;
                if (t > 0 && t < wallDist) wallDist = t;
              }
              
              // USE PHYSICS SIMULATION for final positions (handles bounces correctly)
              if (this.predictionCache.cueBallEnd) {
                predictionDot.style.display = "";
                predictionDot.setAttribute("cx", String(this.predictionCache.cueBallEnd.x));
                predictionDot.setAttribute("cy", String(this.predictionCache.cueBallEnd.y));
                
                if (!this.lastPrediction.locked) {
                  this.lastPrediction.cueBallEnd = { ...this.predictionCache.cueBallEnd };
                }
              } else {
                // Fallback - cue ball final position (stops at wall or by damping)
                const cueFinalDist = Math.min(cueStopDist, wallDist);
                const cueBallFinalX = guideEndX + deflectDirX * cueFinalDist;
                const cueBallFinalY = guideEndY + deflectDirY * cueFinalDist;
                predictionDot.style.display = "";
                predictionDot.setAttribute("cx", String(cueBallFinalX));
                predictionDot.setAttribute("cy", String(cueBallFinalY));
                
                if (!this.lastPrediction.locked) {
                  this.lastPrediction.cueBallEnd = { x: cueBallFinalX, y: cueBallFinalY };
                }
              }
            } else {
              // Full hit or very low remaining velocity - cue ball stops near impact
              if (this.predictionCache.cueBallEnd) {
                predictionDot.style.display = "";
                predictionDot.setAttribute("cx", String(this.predictionCache.cueBallEnd.x));
                predictionDot.setAttribute("cy", String(this.predictionCache.cueBallEnd.y));
                
                if (!this.lastPrediction.locked) {
                  this.lastPrediction.cueBallEnd = { ...this.predictionCache.cueBallEnd };
                }
              } else {
                predictionDot.style.display = "";
                predictionDot.setAttribute("cx", String(guideEndX));
                predictionDot.setAttribute("cy", String(guideEndY));
                
                if (!this.lastPrediction.locked) {
                  this.lastPrediction.cueBallEnd = { x: guideEndX, y: guideEndY };
                }
              }
            }
            
            // Target ball prediction - USE PHYSICS SIMULATION
            if (this.predictionCache.targetBallEnd) {
              predictionTargetDot.style.display = "";
              predictionTargetDot.setAttribute("cx", String(this.predictionCache.targetBallEnd.x));
              predictionTargetDot.setAttribute("cy", String(this.predictionCache.targetBallEnd.y));
              
              if (!this.lastPrediction.locked) {
                // Calculate cut angle (0 = straight, 90 = thin cut)
                const cutAngleRad = Math.acos(Math.min(1, Math.max(-1, vDotN)));
                const cutAngleDeg = cutAngleRad * (180 / Math.PI);

                this.lastPrediction.targetBallEnd = { ...this.predictionCache.targetBallEnd };
                this.lastPrediction.targetBallKey = this.predictionCache.targetBallKey || hitBallKey;
                this.lastPrediction.predictedTargetDir = this.predictionCache.targetBallDir ? 
                  { ...this.predictionCache.targetBallDir } : { x: normX, y: normY };
                this.lastPrediction.hitBallPos = { x: hitBallPos.x, y: hitBallPos.y };
                this.lastPrediction.cutAngle = cutAngleDeg;
              }
            } else if (this.predictionCache.targetBallDir) {
              // Have direction but no end position - use direction to compute position
              const simDirX = this.predictionCache.targetBallDir.x;
              const simDirY = this.predictionCache.targetBallDir.y;
              
              if (targetStopDist > 0.01 && table) {
                const w = table.width / 2;
                const h = table.height / 2;
                
                // Check if target ball hits wall before stopping (using simulated direction)
                let wallDist = targetStopDist;
                if (simDirX > 0.0001) {
                  const t = (w - hitBallRadius - hitBallPos.x) / simDirX;
                  if (t > 0 && t < wallDist) wallDist = t;
                } else if (simDirX < -0.0001) {
                  const t = (-w + hitBallRadius - hitBallPos.x) / simDirX;
                  if (t > 0 && t < wallDist) wallDist = t;
                }
                if (simDirY > 0.0001) {
                  const t = (h - hitBallRadius - hitBallPos.y) / simDirY;
                  if (t > 0 && t < wallDist) wallDist = t;
                } else if (simDirY < -0.0001) {
                  const t = (-h + hitBallRadius - hitBallPos.y) / simDirY;
                  if (t > 0 && t < wallDist) wallDist = t;
                }
                
                // Target ball final position (using simulated direction)
                const targetFinalDist = Math.min(targetStopDist, wallDist);
                const targetBallFinalX = hitBallPos.x + simDirX * targetFinalDist;
                const targetBallFinalY = hitBallPos.y + simDirY * targetFinalDist;
                predictionTargetDot.style.display = "";
                predictionTargetDot.setAttribute("cx", String(targetBallFinalX));
                predictionTargetDot.setAttribute("cy", String(targetBallFinalY));
                
                if (!this.lastPrediction.locked) {
                  // Calculate cut angle (0 = straight, 90 = thin cut)
                  const cutAngleRad = Math.acos(Math.min(1, Math.max(-1, vDotN)));
                  const cutAngleDeg = cutAngleRad * (180 / Math.PI);

                  this.lastPrediction.targetBallEnd = { x: targetBallFinalX, y: targetBallFinalY };
                  this.lastPrediction.targetBallKey = hitBallKey;
                  this.lastPrediction.predictedTargetDir = { x: simDirX, y: simDirY };
                  this.lastPrediction.hitBallPos = { x: hitBallPos.x, y: hitBallPos.y };
                  this.lastPrediction.cutAngle = cutAngleDeg;
                }
              } else {
                predictionTargetDot.style.display = "none";
                if (!this.lastPrediction.locked) {
                  this.lastPrediction.targetBallEnd = null;
                  this.lastPrediction.targetBallKey = null;
                  this.lastPrediction.predictedTargetDir = null;
                  this.lastPrediction.hitBallPos = null;
                  this.lastPrediction.cutAngle = 0;
                }
              }
            } else {
              // Fallback to geometric calculation if no simulation
              if (targetStopDist > 0.01 && table) {
                const w = table.width / 2;
                const h = table.height / 2;
                
                let wallDist = targetStopDist;
                if (normX > 0.0001) {
                  const t = (w - hitBallRadius - hitBallPos.x) / normX;
                  if (t > 0 && t < wallDist) wallDist = t;
                } else if (normX < -0.0001) {
                  const t = (-w + hitBallRadius - hitBallPos.x) / normX;
                  if (t > 0 && t < wallDist) wallDist = t;
                }
                if (normY > 0.0001) {
                  const t = (h - hitBallRadius - hitBallPos.y) / normY;
                  if (t > 0 && t < wallDist) wallDist = t;
                } else if (normY < -0.0001) {
                  const t = (-h + hitBallRadius - hitBallPos.y) / normY;
                  if (t > 0 && t < wallDist) wallDist = t;
                }
                
                const targetFinalDist = Math.min(targetStopDist, wallDist);
                const targetBallFinalX = hitBallPos.x + normX * targetFinalDist;
                const targetBallFinalY = hitBallPos.y + normY * targetFinalDist;
                predictionTargetDot.style.display = "";
                predictionTargetDot.setAttribute("cx", String(targetBallFinalX));
                predictionTargetDot.setAttribute("cy", String(targetBallFinalY));
                
                if (!this.lastPrediction.locked) {
                  const cutAngleRad = Math.acos(Math.min(1, Math.max(-1, vDotN)));
                  const cutAngleDeg = cutAngleRad * (180 / Math.PI);

                  this.lastPrediction.targetBallEnd = { x: targetBallFinalX, y: targetBallFinalY };
                  this.lastPrediction.targetBallKey = hitBallKey;
                  this.lastPrediction.predictedTargetDir = { x: normX, y: normY };
                  this.lastPrediction.hitBallPos = { x: hitBallPos.x, y: hitBallPos.y };
                  this.lastPrediction.cutAngle = cutAngleDeg;
                }
              } else {
                predictionTargetDot.style.display = "none";
                if (!this.lastPrediction.locked) {
                  this.lastPrediction.targetBallEnd = null;
                  this.lastPrediction.targetBallKey = null;
                  this.lastPrediction.predictedTargetDir = null;
                  this.lastPrediction.hitBallPos = null;
                  this.lastPrediction.cutAngle = 0;
                }
              }
            }
            
            if (!this.lastPrediction.locked) {
              this.lastPrediction.timestamp = Date.now();
              this.lastPrediction.power = power;
              this.lastPrediction.hitType = 'ball';
            }
            
            // Update info display
            const infoEl = document.getElementById('dev-prediction-info');
            if (infoEl) {
              const cutAngle = this.lastPrediction.cutAngle || 0;
              infoEl.innerHTML = `Power: ${(power * 100).toFixed(0)}%<br>` +
                `Cut Angle: ${cutAngle.toFixed(1)}�<br>` +
                `Initial V: ${initialVelocity.toFixed(2)} m/s<br>` +
                `Max travel: ${(maxTravelDistance * 1000).toFixed(0)}mm<br>` +
                `Target gets: ${(Math.abs(vDotN) * 100).toFixed(0)}% energy`;
            }
          }
        } else {
          // Wall hit or no hit - cue ball travels until stopped by damping or wall
          if (table) {
            const w = table.width / 2;
            const h = table.height / 2;
            
            // Check wall intersection
            let wallDist = maxTravelDistance;
            if (shotDx > 0.0001) {
              const t = (w - BALL_RADIUS - ballX) / shotDx;
              if (t > 0 && t < wallDist) wallDist = t;
            } else if (shotDx < -0.0001) {
              const t = (-w + BALL_RADIUS - ballX) / shotDx;
              if (t > 0 && t < wallDist) wallDist = t;
            }
            if (shotDy > 0.0001) {
              const t = (h - BALL_RADIUS - ballY) / shotDy;
              if (t > 0 && t < wallDist) wallDist = t;
            } else if (shotDy < -0.0001) {
              const t = (-h + BALL_RADIUS - ballY) / shotDy;
              if (t > 0 && t < wallDist) wallDist = t;
            }
            
            const finalDist = Math.min(maxTravelDistance, wallDist);
            const cueBallFinalX = ballX + shotDx * finalDist;
            const cueBallFinalY = ballY + shotDy * finalDist;
            
            predictionDot.style.display = "";
            predictionDot.setAttribute("cx", String(cueBallFinalX));
            predictionDot.setAttribute("cy", String(cueBallFinalY));
            predictionTargetDot.style.display = "none";
            
            if (!this.lastPrediction.locked) {
              this.lastPrediction.cueBallEnd = { x: cueBallFinalX, y: cueBallFinalY };
              this.lastPrediction.targetBallEnd = null;
              this.lastPrediction.targetBallKey = null;
              this.lastPrediction.timestamp = Date.now();
              this.lastPrediction.power = power;
              this.lastPrediction.hitType = hitType;
            }
            
            const infoEl = document.getElementById('dev-prediction-info');
            if (infoEl) {
              infoEl.innerHTML = `Power: ${(power * 100).toFixed(0)}%<br>` +
                `Initial V: ${initialVelocity.toFixed(2)} m/s<br>` +
                `Max travel: ${(maxTravelDistance * 1000).toFixed(0)}mm<br>` +
                `Hit type: ${hitType}`;
            }
          }
        }
      } else {
        predictionDot.style.display = "none";
        predictionTargetDot.style.display = "none";
      }
      // --------------------------
      
      // Cue dimensions
      const cueLength = 0.6;
      const minGap = 0.02;
      const gap = minGap + dist * 0.08;
      
      // Cue TIP position (behind the ball, opposite to shot direction)
      const tipX = ballX + nx * gap;
      const tipY = ballY + ny * gap;
      
      // Cue BUTT position (further behind)
      const buttX = tipX + nx * cueLength;
      const buttY = tipY + ny * cueLength;
      
      // Section lengths
      const tipLen = 0.01;
      const ferruleLen = 0.018;
      const shaftLen = cueLength * 0.5;
      const wrapLen = 0.05;
      
      let pos = 0;
      
      // Tip (closest to ball)
      tip.setAttribute("cx", String(tipX));
      tip.setAttribute("cy", String(tipY));
      pos += tipLen;
      
      // Ferrule
      ferrule.setAttribute("x1", String(tipX + nx * pos));
      ferrule.setAttribute("y1", String(tipY + ny * pos));
      pos += ferruleLen;
      ferrule.setAttribute("x2", String(tipX + nx * pos));
      ferrule.setAttribute("y2", String(tipY + ny * pos));
      
      // Shaft
      shaft.setAttribute("x1", String(tipX + nx * pos));
      shaft.setAttribute("y1", String(tipY + ny * pos));
      pos += shaftLen;
      shaft.setAttribute("x2", String(tipX + nx * pos));
      shaft.setAttribute("y2", String(tipY + ny * pos));
      
      // Wrap
      wrap.setAttribute("x1", String(tipX + nx * pos));
      wrap.setAttribute("y1", String(tipY + ny * pos));
      pos += wrapLen;
      wrap.setAttribute("x2", String(tipX + nx * pos));
      wrap.setAttribute("y2", String(tipY + ny * pos));
      
      // Butt
      butt.setAttribute("x1", String(tipX + nx * pos));
      butt.setAttribute("y1", String(tipY + ny * pos));
      butt.setAttribute("x2", String(buttX));
      butt.setAttribute("y2", String(buttY));
      
      // Shadow
      const so = 0.005;
      shadow.setAttribute("x1", String(tipX + so));
      shadow.setAttribute("y1", String(tipY + so));
      shadow.setAttribute("x2", String(buttX + so));
      shadow.setAttribute("y2", String(buttY + so));
    },
    exit: (data, element) => {
      element.remove();
    },
  });

  dataset = Dataset.create<Ball | Rail | Pocket | CueStick | Table>({
    key: (data) => data.key,
  });
}
