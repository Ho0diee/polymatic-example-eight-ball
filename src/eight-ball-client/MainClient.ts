import { Middleware } from "polymatic";

import { Terminal } from "./Terminal";
import { FrameLoop } from "./FrameLoop";
import { CueShot } from "../eight-ball/CueShot";
import { RoomClient } from "./RoomClient";
import { StatusOnline } from "./StatusOnline";
import { type ClientBilliardContext } from "./ClientContext";
import { ScoreboardUI } from "./ScoreboardUI";
import { Physics } from "../eight-ball/Physics";
import { EightBall2P } from "../eight-ball/EightBall2P";
import { SoundManager } from "./SoundManager";

/**
 * Main class for the billiard game client.
 */
export class MainClient extends Middleware<ClientBilliardContext> {
  constructor() {
    super();
    this.use(new FrameLoop());
    this.use(new Physics());      // Run physics locally for smooth animation
    this.use(new EightBall2P());  // Game rules (for ball pocketing, etc.)
    this.use(new CueShot());
    this.use(new Terminal());
    this.use(new RoomClient());
    this.use(new StatusOnline());
    this.use(new ScoreboardUI());
    this.use(new SoundManager());  // Audio feedback
  }
}
