import { World, Circle, Vec2, Settings } from "planck";

// EXACT PHYSICS CONSTANTS FROM THE GAME
const BALL_RADIUS = 0.031;
const LINEAR_DAMPING = 2.2;
const ANGULAR_DAMPING = 1.5;
const BALL_FRICTION = 0.1;
const BALL_RESTITUTION = 0.99;
const MAX_FORCE = 0.06;

function measureDistance(power: number): number {
    Settings.velocityThreshold = 0;
    const world = new World();
    
    const ball = world.createBody({
        type: 'dynamic',
        bullet: true,
        position: { x: 0, y: 0 },
        linearDamping: LINEAR_DAMPING,
        angularDamping: ANGULAR_DAMPING
    });
    ball.createFixture({
        shape: new Circle(BALL_RADIUS),
        friction: BALL_FRICTION,
        restitution: BALL_RESTITUTION,
        density: 1
    });
    
    const impulse = power * MAX_FORCE;
    ball.applyLinearImpulse({ x: impulse, y: 0 }, ball.getPosition());
    
    const timeStep = 1 / 120;
    let totalDistance = 0;
    let lastPos = { x: 0, y: 0 };
    
    for (let i = 0; i < 1200; i++) {
        world.step(timeStep);
        
        const pos = ball.getPosition();
        const vel = ball.getLinearVelocity();
        const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
        
        const dx = pos.x - lastPos.x;
        const dy = pos.y - lastPos.y;
        totalDistance += Math.sqrt(dx * dx + dy * dy);
        lastPos = { x: pos.x, y: pos.y };
        
        if (speed < 0.001) break;
    }
    
    return totalDistance;
}

// Run tests
const powers = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.25, 1.5, 1.75, 2.0];
console.log("Power -> Distance (m) -> Distance (cm) -> Ratio (distance/power)");
console.log("================================================================");

let sumRatio = 0;
for (const p of powers) {
    const d = measureDistance(p);
    const ratio = d / p;
    sumRatio += ratio;
    console.log(`${p.toFixed(2)} -> ${d.toFixed(4)}m -> ${(d * 100).toFixed(1)}cm -> ratio: ${ratio.toFixed(4)}`);
}

const avgRatio = sumRatio / powers.length;
console.log("================================================================");
console.log(`Average ratio: ${avgRatio.toFixed(4)}`);
console.log(`\nFormula: maxTravelDistance = power * ${avgRatio.toFixed(2)}`);
console.log(`\nFor code: const DISTANCE_PER_POWER = ${avgRatio.toFixed(2)};`);
