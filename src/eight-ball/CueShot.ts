import { Middleware } from "polymatic";

import { CueStick, type BilliardContext } from "./BilliardContext";
import { isMyTurn } from "../eight-ball-client/ClientContext";

/**
 * Implements cue and shot:
 * - Listens to user pointer input events (from Terminal)
 * - Updates the cue stick object in the context
 * - Emits cue-shot events
 */
export class CueShot extends Middleware<BilliardContext> {
  aimVector = { x: -1, y: 0 };
  power = 0;

  constructor() {
    super();
    this.on("user-pointer-start", this.handlePointerStart);
    this.on("user-pointer-move", this.handlePointerMove);
    // this.on("user-pointer-end", this.handlePointerUp); // No longer shooting on pointer up
    
    this.on("user-power-change", this.handlePowerChange);
    this.on("user-power-release", this.handlePowerRelease);
    
    this.on("frame-loop", this.handleFrameLoop);
  }

  handleFrameLoop() {
    // Hide cue during shot (balls moving)
    if (this.context.shotInProgress) {
      if (this.context.cue) {
        this.context.cue = null;
      }
      return;
    }

    // Auto-spawn cue if it's my turn and missing
    if (isMyTurn(this.context) && !this.context.cue && !this.context.gameOver) {
       const ball = this.context.balls?.find(b => b.color === 'white');
       if (ball) {
         const cue = new CueStick();
         cue.ball = ball;
         cue.start.x = ball.position.x;
         cue.start.y = ball.position.y;
         this.context.cue = cue;
         this.updateCuePosition();
       }
       return;
    }

    const cue = this.context.cue;
    if (!cue || !cue.ball) return;
    
    // Only update position, don't recreate
    cue.start.x = cue.ball.position.x;
    cue.start.y = cue.ball.position.y;
    this.updateCuePosition();
  }

  updateCuePosition() {
    const cue = this.context.cue;
    if (!cue) return;

    // Base distance controls the gap when power is 0
    // Terminal.ts uses: gap = minGap + dist * 0.08
    // We want gap to be small when power is 0, and large when power is 1
    const dist = 0.5 + (this.power * 8); 
    
    // Place cue handle on the SAME side as the aim vector (mouse position)
    cue.end.x = cue.start.x + this.aimVector.x * dist;
    cue.end.y = cue.start.y + this.aimVector.y * dist;
  }

  handlePointerStart(point: { x: number; y: number }) {
    if (!isMyTurn(this.context)) return;
    
    if (!this.context.cue) {
        const ball = this.context.balls.find((ball) => ball.color === "white");
        if (!ball) return;
        const cue = new CueStick();
        cue.ball = ball;
        cue.start.x = ball.position.x;
        cue.start.y = ball.position.y;
        this.context.cue = cue;
    }
    
    this.updateAim(point);
  }

  handlePointerMove(point: { x: number; y: number }) {
    if (!this.context.cue) return;
    this.updateAim(point);
  }
  
  updateAim(point: { x: number; y: number }) {
    const cue = this.context.cue;
    if (!cue) return;
    
    const dx = point.x - cue.start.x;
    const dy = point.y - cue.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    
    if (len > 0.001) {
        this.aimVector.x = dx / len;
        this.aimVector.y = dy / len;
    }
    
    this.updateCuePosition();
  }

  handlePowerChange(power: number) {
    this.power = power;
    this.updateCuePosition();
  }

  handlePowerRelease(power: number) {
    const cue = this.context.cue;
    if (!cue || !isMyTurn(this.context)) return;
    
    // Shot power
    const maxForce = 0.06; 
    const force = power * maxForce;
    
    if (force > 0.001) {
        // Shot goes OPPOSITE to the aim vector (away from the cue stick)
        const shot = { 
            x: -this.aimVector.x * force, 
            y: -this.aimVector.y * force 
        };
        const ball = cue.ball;
        this.context.cue = null;
        this.emit("cue-shot", { ball, shot });
    }
    
    this.power = 0;
  }
}
