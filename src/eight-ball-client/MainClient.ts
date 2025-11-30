import { Middleware } from "polymatic";

import { Terminal } from "./Terminal";
import { FrameLoop } from "./FrameLoop";
import { CueShot } from "../eight-ball/CueShot";
import { RoomClient } from "./RoomClient";
import { StatusOnline } from "./StatusOnline";
import { type ClientBilliardContext } from "./ClientContext";
import { ScoreboardUI } from "./ScoreboardUI";
// import { Physics } from "../eight-ball/Physics";
import { EightBall2P } from "../eight-ball/EightBall2P";
import { SoundManager } from "./SoundManager";

/**
 * Main class for the billiard game client.
 */
export class MainClient extends Middleware<ClientBilliardContext> {
  constructor() {
    super();
    this.use(new FrameLoop());
    // Use web worker for physics simulation
    this.physicsWorker = new Worker("../physics-worker.js");
    this.physicsWorker.onmessage = (event) => {
      const { type, state } = event.data;
      if (type === "update") {
        // Update game state from worker
        Object.assign(this.context, state);
      }
    };

    // Send initial game state to worker
    this.physicsWorker.postMessage({ type: "init", data: this.context });

    // On each frame, send frame-loop event to worker
    this.on("frame-loop", (ev) => {
      this.physicsWorker.postMessage({ type: "step", data: { dt: ev.dt } });
    });

    // On cue shot, send shot to worker
    this.on("cue-shot", (data) => {
      this.physicsWorker.postMessage({ type: "shot", data });
    });
    this.use(new EightBall2P());  // Game rules (for ball pocketing, etc.)
    this.use(new CueShot());
    this.use(new Terminal());
    this.use(new RoomClient());
    this.use(new StatusOnline());
    this.use(new ScoreboardUI());
    this.use(new SoundManager());  // Audio feedback
  }
}
