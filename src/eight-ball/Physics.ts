import { World, Circle, Polygon, type Vec2Value, Contact, Body, Settings } from "planck";
import { Dataset, Driver, Middleware } from "polymatic";

import { Ball, Pocket, Rail, type BilliardContext } from "./BilliardContext";

export type Entity = Ball | Rail | Pocket;

/**
 * Billiards physics simulation. This doesn't include any game rules, or table geometry.
 */
export class Physics extends Middleware<BilliardContext> {
  world: World;

  time: number = 0;
  timeStep = 1000 / 480;

  pocketedBalls: Ball[] = [];

  asleep = true;

  // Break shot detection
  isBreakShot: boolean = true; // First shot is always break

  // Store pre-collision velocities for accurate sound timing
  private preStepVelocities: Map<Body, { x: number; y: number }> = new Map();
  
  // Queue collision events to emit after physics frame completes
  // This ensures sounds play after positions are updated for rendering
  private pendingCollisions: Array<{ type: 'ball' | 'rail'; data: any }> = [];
  
  // Track which balls have had rail sounds played (to avoid duplicates)
  private railSoundPlayed: Set<string> = new Set();

  constructor() {
    super();
    this.on("activate", this.setup);
    this.on("frame-loop", this.handleFrameLoop);
    this.on("cue-shot", this.handleCueShot);

    this.dataset.addDriver(this.ballDriver);
    this.dataset.addDriver(this.railDriver);
    this.dataset.addDriver(this.pocketDriver);
  }

  handleCueShot(data: { ball: Ball; shot: Vec2Value }) {
    if (this.context.shotInProgress || this.context.gameOver) return;
    const body = this.ballDriver.ref(data.ball.key);
    if (!body) return;
    this.asleep = false;
    body.applyLinearImpulse(data.shot, body.getPosition());
    this.context.shotInProgress = true;
    this.emit("shot-start", { ball: data.ball });
  }

  setup() {
    Settings.velocityThreshold = 0;
    this.world = new World();
    this.world.on("begin-contact", this.collide);
  }

  handleFrameLoop(ev: { dt: number }) {
    if (!this.context.balls || !this.context.rails || !this.context.pockets) return;
    
    // Sync physics bodies with data (creates bodies for new balls, etc.)
    // This must happen before physics step to register new objects
    this.dataset.data([...this.context?.balls, ...this.context?.rails, , ...this.context?.pockets]);
    
    // Fixed 80% speed (slightly slower than normal)
    const effectiveDt = ev.dt * 0.8;
    
    this.time += effectiveDt;
    while (this.time >= this.timeStep) {
      this.time -= this.timeStep;
      if (this.asleep) continue;
      
      // Capture velocities BEFORE physics step for accurate collision sounds
      this.preStepVelocities.clear();
      for (let b = this.world.getBodyList(); b; b = b.getNext()) {
        if (!b.isStatic()) {
          const vel = b.getLinearVelocity();
          this.preStepVelocities.set(b, { x: vel.x, y: vel.y });
        }
      }
      
      this.world.step(this.timeStep / 1000);
    }
    
    // Predictive rail sound - play 5 frames before collision
    // Check each ball's distance to rails and predict collision
    this.predictRailCollisions();
    
    // Update positions AFTER physics step so rendering matches collision timing
    // This ensures the ball visually touches the rail when the sound plays
    this.dataset.data([...this.context?.balls, ...this.context?.rails, , ...this.context?.pockets]);
    
    // Emit queued collision events after a microtask delay
    // This ensures ALL frame-loop handlers (including Terminal) run first
    // So the visual position update happens before the sound plays
    if (this.pendingCollisions.length > 0) {
      const collisions = [...this.pendingCollisions];
      this.pendingCollisions.length = 0;
      
      queueMicrotask(() => {
        for (const collision of collisions) {
          if (collision.type === 'ball') {
            this.emit("ball-collision", collision.data);
          } else {
            this.emit("rail-collision", collision.data);
          }
        }
      });
    }

    if (!this.asleep) {
      let asleep = true;
      for (let b = this.world.getBodyList(); b && asleep; b = b.getNext()) {
        if (!b.isStatic()) {
          const vel = b.getLinearVelocity();
          const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
          // Consider ball stopped if speed is below threshold (faster shot ending)
          if (speed > 0.015) {
            asleep = false;
          } else {
            // Force stop very slow balls
            b.setLinearVelocity({ x: 0, y: 0 });
            b.setAngularVelocity(0);
          }
        }
      }
      this.asleep = asleep;
      if (this.asleep && this.context.shotInProgress) {
        this.endShot();
      }
    }
    
    // Clear rail sound tracking when balls stop
    if (this.asleep) {
      this.railSoundPlayed.clear();
    }
  }
  
  // Predict rail collisions ~5 frames ahead and play sound early
  predictRailCollisions() {
    if (!this.context.balls || !this.context.table) return;
    
    const table = this.context.table;
    const halfW = table.width / 2;
    const halfH = table.height / 2;
    
    // ~120ms ahead at 60fps = ~7 frames
    const lookAheadTime = 0.120; // 120ms in seconds
    
    // Distance-based prediction: play sound when ball is close to rail
    const railProximity = 0.04; // Play sound when within 4cm of rail
    for (const ball of this.context.balls) {
      const body = this.ballDriver.ref(ball.key);
      if (!body) continue;
      const vel = body.getLinearVelocity();
      const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
      if (speed < 0.05) continue; // Not moving fast enough
      const pos = ball.position;
      const r = ball.radius;
      // Check proximity to each rail
      const nearRight = (halfW - (pos.x + r)) < railProximity && vel.x > 0;
      const nearLeft = ((pos.x - r) + halfW) < railProximity && vel.x < 0;
      const nearTop = ((pos.y - r) + halfH) < railProximity && vel.y < 0;
      const nearBottom = (halfH - (pos.y + r)) < railProximity && vel.y > 0;
      // Clear keys for rails the ball is moving AWAY from
      const keyR = `${ball.key}-R`;
      const keyL = `${ball.key}-L`;
      const keyT = `${ball.key}-T`;
      const keyB = `${ball.key}-B`;
      if (vel.x < 0) this.railSoundPlayed.delete(keyR);
      if (vel.x > 0) this.railSoundPlayed.delete(keyL);
      if (vel.y > 0) this.railSoundPlayed.delete(keyT);
      if (vel.y < 0) this.railSoundPlayed.delete(keyB);
      if (nearRight || nearLeft || nearTop || nearBottom) {
        const direction = nearRight ? 'R' : nearLeft ? 'L' : nearTop ? 'T' : 'B';
        const key = `${ball.key}-${direction}`;
        if (!this.railSoundPlayed.has(key)) {
          this.railSoundPlayed.add(key);
          const impactSpeed = (nearRight || nearLeft) ? Math.abs(vel.x) : Math.abs(vel.y);
          if (impactSpeed > 0.05) {
            this.emit("rail-collision", { ball, speed: impactSpeed });
          }
        }
      }
    }
    
    // Time-based prediction: play sound when ball is 120ms from rail
    const anticipationTime = 0.12; // seconds
    for (const ball of this.context.balls) {
      const body = this.ballDriver.ref(ball.key);
      if (!body) continue;
      const vel = body.getLinearVelocity();
      const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
      if (speed < 0.05) continue; // Not moving fast enough
      const pos = ball.position;
      const r = ball.radius;
      // Calculate distance to each rail
      const distRight = halfW - (pos.x + r);
      const distLeft = (pos.x - r) + halfW;
      const distTop = (pos.y - r) + halfH;
      const distBottom = halfH - (pos.y + r);
      // Predict collision in 120ms
      const willHitRight = distRight > 0 && vel.x > 0 && distRight <= speed * anticipationTime;
      const willHitLeft = distLeft > 0 && vel.x < 0 && distLeft <= speed * anticipationTime;
      const willHitTop = distTop > 0 && vel.y < 0 && distTop <= speed * anticipationTime;
      const willHitBottom = distBottom > 0 && vel.y > 0 && distBottom <= speed * anticipationTime;
      // Clear keys for rails the ball is moving AWAY from
      const keyR = `${ball.key}-R`;
      const keyL = `${ball.key}-L`;
      const keyT = `${ball.key}-T`;
      const keyB = `${ball.key}-B`;
      if (vel.x < 0) this.railSoundPlayed.delete(keyR);
      if (vel.x > 0) this.railSoundPlayed.delete(keyL);
      if (vel.y > 0) this.railSoundPlayed.delete(keyT);
      if (vel.y < 0) this.railSoundPlayed.delete(keyB);
      if (willHitRight || willHitLeft || willHitTop || willHitBottom) {
        const direction = willHitRight ? 'R' : willHitLeft ? 'L' : willHitTop ? 'T' : 'B';
        const key = `${ball.key}-${direction}`;
        if (!this.railSoundPlayed.has(key)) {
          this.railSoundPlayed.add(key);
          const impactSpeed = (willHitRight || willHitLeft) ? Math.abs(vel.x) : Math.abs(vel.y);
          if (impactSpeed > 0.05) {
            this.emit("rail-collision", { ball, speed: impactSpeed });
          }
        }
      }
    }
  }
  
  endShot() {
    if (!this.context.shotInProgress) return;
    this.context.shotInProgress = false;
    const pocketed = [...this.pocketedBalls];
    this.pocketedBalls.length = 0;
    
    // Reset break shot state after first shot
    if (this.isBreakShot) {
      this.isBreakShot = false;
    }
    
    this.emit("shot-end", { pocketed });
  }

  collide = (contact: Contact) => {
    const fA = contact.getFixtureA();
    const bA = fA.getBody();
    const fB = contact.getFixtureB();
    const bB = fB.getBody();

    const dataA = bA.getUserData() as Entity;
    const dataB = bB.getUserData() as Entity;

    if (!dataA || !dataB) return;

    const ball1 = dataA.type === "ball" ? dataA : null;
    const ball2 = dataB.type === "ball" ? dataB : null;
    const ball = ball1 || ball2;
    const rail = dataA.type === "rail" ? dataA : dataB.type === "rail" ? dataB : null;
    const pocket = dataA.type === "pocket" ? dataA : dataB.type === "pocket" ? dataB : null;

    // Ball-ball collision - queue sound event with impact velocity
    // Use pre-step velocities for accurate impact speed (before collision response)
    if (ball1 && ball2) {
      const preVel1 = this.preStepVelocities.get(bA) || bA.getLinearVelocity();
      const preVel2 = this.preStepVelocities.get(bB) || bB.getLinearVelocity();
      const relVelX = preVel1.x - preVel2.x;
      const relVelY = preVel1.y - preVel2.y;
      const impactSpeed = Math.sqrt(relVelX * relVelX + relVelY * relVelY);
      if (impactSpeed > 0.05) {
        // Queue for emission after frame completes (so visuals update first)
        this.pendingCollisions.push({ type: 'ball', data: { ball1, ball2, impactSpeed } });
      }
    }

    // Ball-rail collision - sound is handled by predictRailCollisions() instead
    // This runs ~5 frames before the actual collision for better sync

    if (pocket) {
      // do not apply any force to the ball
      contact.setEnabled(false);
    }

    if (ball && pocket) {
      // do not change world immediately
      this.pocketedBalls.push(ball);
      const index = this.context.balls.indexOf(ball);
      if (index >= 0) {
        this.context.balls.splice(index, 1);
      }
      // Emit immediately so UI can update, include pocket position for animation
      this.emit("ball-pocketed", { ball, pocket });
    }
  };

  dataset = Dataset.create<Entity>({
    key: (data) => data.key,
  });

  ballDriver = Driver.create<Ball, Body>({
    filter: (data) => data.type === "ball",
    enter: (data) => {
      const body = this.world.createBody({
        type: "dynamic",
        bullet: true,
        position: data.position,
        linearDamping: 2.2,
        angularDamping: 1.5,
        userData: data,
      });
      body.createFixture({
        shape: new Circle(data.radius),
        friction: 0.1,
        restitution: 0.99,
        density: 1,
        userData: data,
      });
      return body;
    },
    update: (data, body) => {
      const p = body.getPosition();
      // we only need three decimal position (millimeter) outside physics simulation
      data.position.x = ((p.x * 1000) | 0) / 1000;
      data.position.y = ((p.y * 1000) | 0) / 1000;
      data.angle = body.getAngle();
    },
    exit: (data, body) => {
      this.world.destroyBody(body);
    },
  });

  railDriver = Driver.create<Rail, Body>({
    filter: (data) => data.type === "rail",
    enter: (data) => {
      const body = this.world.createBody({
        type: "static",
        userData: data,
      });
      const fixture = body.createFixture({
        shape: new Polygon(data.vertices),
        friction: 0.1,
        restitution: 0.9,
        userData: data,
      });
      return body;
    },
    update: (data, body) => {},
    exit: (data, body) => {
      this.world.destroyBody(body);
    },
  });

  pocketDriver = Driver.create<Pocket, Body>({
    filter: (data) => data.type === "pocket",
    enter: (data) => {
      const body = this.world.createBody({
        type: "static",
        position: data.position,
        userData: data,
      });
      const fixture = body.createFixture({
        shape: new Circle(data.radius),
        userData: data,
      });
      return body;
    },
    update: (data, body) => {},
    exit: (data, body) => {
      this.world.destroyBody(body);
    },
  });
}
