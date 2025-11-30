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
    console.log("[Physics] handleCueShot called", { shotInProgress: this.context.shotInProgress, gameOver: this.context.gameOver });
    if (this.context.shotInProgress || this.context.gameOver) {
      console.log("[Physics] Ignoring shot because shotInProgress or gameOver is true");
      return;
    }
    const body = this.ballDriver.ref(data.ball.key);
    if (!body) {
      console.error("[Physics] Could not find physics body for ball", data.ball.key);
      return;
    }
    console.log("[Physics] Applying impulse to ball", data.ball.key);
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
    this.dataset.data([...this.context?.balls, ...this.context?.rails, , ...this.context?.pockets]);
    
    // Fixed 80% speed (slightly slower than normal)
    const effectiveDt = ev.dt * 0.8;
    
    this.time += effectiveDt;
    while (this.time >= this.timeStep) {
      this.time -= this.timeStep;
      if (this.asleep) continue;
      this.world.step(this.timeStep / 1000);
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

    // Ball-ball collision - emit sound event with impact velocity
    if (ball1 && ball2) {
      const vel1 = bA.getLinearVelocity();
      const vel2 = bB.getLinearVelocity();
      const relVelX = vel1.x - vel2.x;
      const relVelY = vel1.y - vel2.y;
      const impactSpeed = Math.sqrt(relVelX * relVelX + relVelY * relVelY);
      if (impactSpeed > 0.05) {
        this.emit("ball-collision", { ball1, ball2, impactSpeed });
      }
    }

    // Ball-rail collision - emit sound event
    if (ball && rail) {
      const body = ball1 ? bA : bB;
      const vel = body.getLinearVelocity();
      const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
      if (speed > 0.08) {
        this.emit("rail-collision", { ball, speed });
      }
    }

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
