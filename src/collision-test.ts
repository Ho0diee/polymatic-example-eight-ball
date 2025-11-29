import { World, Circle, Vec2, Settings } from "planck";

// Physics constants from the actual game
const LINEAR_DAMPING = 2.2;
const ANGULAR_DAMPING = 1.5;
const BALL_FRICTION = 0.1;
const BALL_RESTITUTION = 0.99;
const BALL_RADIUS = 0.031;

interface TestResult {
  hitAngle: number;
  predTargetAngle: number | null;
  actTargetAngle: number | null;
  targetError: number | null;
  predCueAngle: number | null;
  actCueAngle: number | null;
  cueError: number | null;
}

// Calculate ghost ball position (where cue ball will be at impact)
function calculateGhostBallPosition(
  cueBallPos: { x: number; y: number },
  targetBallPos: { x: number; y: number },
  shotDir: { x: number; y: number }
): { x: number; y: number } | null {
  const combinedRadius = BALL_RADIUS * 2;
  
  const vx = targetBallPos.x - cueBallPos.x;
  const vy = targetBallPos.y - cueBallPos.y;
  const distSq = vx * vx + vy * vy;
  
  const t = vx * shotDir.x + vy * shotDir.y;
  const dSq = distSq - t * t;
  const combinedRadiusSq = combinedRadius * combinedRadius;
  
  if (dSq >= combinedRadiusSq) return null;
  
  const dt = Math.sqrt(combinedRadiusSq - dSq);
  const hitDist = t - dt;
  
  if (hitDist < 0) return null;
  
  return {
    x: cueBallPos.x + shotDir.x * hitDist,
    y: cueBallPos.y + shotDir.y * hitDist
  };
}

// Calculate predicted directions using the same geometry as the game
function calculatePredictedDirections(
  cueBallPos: { x: number; y: number },
  targetBallPos: { x: number; y: number },
  shotDir: { x: number; y: number }
): { targetDir: { x: number; y: number } | null; cueDir: { x: number; y: number } | null } {
  const ghostPos = calculateGhostBallPosition(cueBallPos, targetBallPos, shotDir);
  if (!ghostPos) return { targetDir: null, cueDir: null };
  
  // Target direction: from ghost ball to target center
  const toTargetX = targetBallPos.x - ghostPos.x;
  const toTargetY = targetBallPos.y - ghostPos.y;
  const toTargetLen = Math.sqrt(toTargetX * toTargetX + toTargetY * toTargetY);
  
  const targetDir = toTargetLen > 0.0001 
    ? { x: toTargetX / toTargetLen, y: toTargetY / toTargetLen }
    : null;
  
  // Cue deflection: tangent line (perpendicular to hit direction)
  let cueDir: { x: number; y: number } | null = null;
  if (targetDir) {
    const dotProduct = shotDir.x * targetDir.x + shotDir.y * targetDir.y;
    let deflectX = shotDir.x - dotProduct * targetDir.x;
    let deflectY = shotDir.y - dotProduct * targetDir.y;
    const deflectLen = Math.sqrt(deflectX * deflectX + deflectY * deflectY);
    
    if (deflectLen > 0.001) {
      cueDir = { x: deflectX / deflectLen, y: deflectY / deflectLen };
    } else {
      cueDir = { x: shotDir.x, y: shotDir.y };
    }
  }
  
  return { targetDir, cueDir };
}

// Run actual physics simulation using Planck.js
function runPhysicsSimulation(
  cueBallPos: { x: number; y: number },
  targetBallPos: { x: number; y: number },
  shotDir: { x: number; y: number }
): { targetDir: { x: number; y: number } | null; cueDir: { x: number; y: number } | null } {
  Settings.velocityThreshold = 0;
  const world = new World();
  
  // Create cue ball
  const cueBall = world.createDynamicBody({
    position: Vec2(cueBallPos.x, cueBallPos.y),
    linearDamping: LINEAR_DAMPING,
    angularDamping: ANGULAR_DAMPING,
    bullet: true
  });
  cueBall.createFixture(Circle(BALL_RADIUS), {
    friction: BALL_FRICTION,
    restitution: BALL_RESTITUTION,
    density: 1.0
  });
  
  // Create target ball
  const targetBall = world.createDynamicBody({
    position: Vec2(targetBallPos.x, targetBallPos.y),
    linearDamping: LINEAR_DAMPING,
    angularDamping: ANGULAR_DAMPING,
    bullet: true
  });
  targetBall.createFixture(Circle(BALL_RADIUS), {
    friction: BALL_FRICTION,
    restitution: BALL_RESTITUTION,
    density: 1.0
  });
  
  // Apply impulse to cue ball
  const impulse = 0.03;
  cueBall.applyLinearImpulse(
    Vec2(shotDir.x * impulse, shotDir.y * impulse),
    cueBall.getPosition()
  );
  
  // Step simulation until collision detected
  let targetDir: { x: number; y: number } | null = null;
  let cueDir: { x: number; y: number } | null = null;
  const timeStep = 1 / 120;
  
  for (let i = 0; i < 240; i++) {
    world.step(timeStep);
    
    const targetVel = targetBall.getLinearVelocity();
    const targetSpeed = Math.sqrt(targetVel.x * targetVel.x + targetVel.y * targetVel.y);
    
    if (targetSpeed > 0.001) {
      targetDir = { x: targetVel.x / targetSpeed, y: targetVel.y / targetSpeed };
      
      const cueVel = cueBall.getLinearVelocity();
      const cueSpeed = Math.sqrt(cueVel.x * cueVel.x + cueVel.y * cueVel.y);
      if (cueSpeed > 0.001) {
        cueDir = { x: cueVel.x / cueSpeed, y: cueVel.y / cueSpeed };
      }
      break;
    }
  }
  
  return { targetDir, cueDir };
}

function dirToAngle(dir: { x: number; y: number } | null): number | null {
  if (!dir) return null;
  return Math.atan2(dir.y, dir.x) * 180 / Math.PI;
}

function angleDiff(a1: number | null, a2: number | null): number | null {
  if (a1 === null || a2 === null) return null;
  let diff = Math.abs(a1 - a2);
  if (diff > 180) diff = 360 - diff;
  return diff;
}

function runTest(hitAngle: number): TestResult {
  // Fixed positions
  const cueBallPos = { x: -0.1, y: 0 };
  const targetBallPos = { x: 0.1, y: 0 };
  
  // Calculate shot direction to hit at the specified angle
  const angleRad = hitAngle * Math.PI / 180;
  const combinedRadius = BALL_RADIUS * 2;
  const ghostX = targetBallPos.x - Math.cos(angleRad) * combinedRadius;
  const ghostY = targetBallPos.y - Math.sin(angleRad) * combinedRadius;
  
  // Shot direction from cue ball to ghost position
  const dx = ghostX - cueBallPos.x;
  const dy = ghostY - cueBallPos.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const shotDir = { x: dx / dist, y: dy / dist };
  
  // Get predictions (geometric)
  const predicted = calculatePredictedDirections(cueBallPos, targetBallPos, shotDir);
  
  // Run actual physics
  const actual = runPhysicsSimulation(cueBallPos, targetBallPos, shotDir);
  
  // Calculate errors
  const predTargetAngle = dirToAngle(predicted.targetDir);
  const actTargetAngle = dirToAngle(actual.targetDir);
  const targetError = angleDiff(predTargetAngle, actTargetAngle);
  
  const predCueAngle = dirToAngle(predicted.cueDir);
  const actCueAngle = dirToAngle(actual.cueDir);
  const cueError = angleDiff(predCueAngle, actCueAngle);
  
  return {
    hitAngle,
    predTargetAngle,
    actTargetAngle,
    targetError,
    predCueAngle,
    actCueAngle,
    cueError
  };
}

// Export for use in HTML
export function runAllTests(): TestResult[] {
  const results: TestResult[] = [];
  for (let angle = -80; angle <= 80; angle += 5) {
    results.push(runTest(angle));
  }
  return results;
}

export function runDetailedTests(): TestResult[] {
  const results: TestResult[] = [];
  for (let angle = -85; angle <= 85; angle += 1) {
    results.push(runTest(angle));
  }
  return results;
}

// Make available globally
(window as any).collisionTest = {
  runAllTests,
  runDetailedTests,
  runTest
};

// Auto-run on load
console.log("Collision test module loaded!");
console.log("Running sample test at 30°...");
const sample = runTest(30);
console.log("Sample result:", sample);
console.log("Target direction error:", sample.targetError?.toFixed(2) + "°");
console.log("Cue deflection error:", sample.cueError?.toFixed(2) + "°");
