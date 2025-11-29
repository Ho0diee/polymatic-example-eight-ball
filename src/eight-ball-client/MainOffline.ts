import { Middleware } from "polymatic";

import { PoolTable } from "../eight-ball/PoolTable";
import { EightBall2P } from "../eight-ball/EightBall2P";
import { TurnBased } from "../eight-ball/TurnBased";
import { Terminal } from "./Terminal";
import { FrameLoop } from "./FrameLoop";
import { CueShot } from "../eight-ball/CueShot";
import { Physics } from "../eight-ball/Physics";
import { type BilliardContext } from "../eight-ball/BilliardContext";
import { StatusOffline } from "./StatusOffline";
import { Rack } from "../eight-ball/Rack";
import { ScoreboardUI } from "./ScoreboardUI";

/**
 * Main class for the offline billiard game.
 */
export class MainOffline extends Middleware<BilliardContext> {
  constructor() {
    super();
    this.use(new FrameLoop());
    this.use(new PoolTable());
    this.use(new Rack());
    this.use(new EightBall2P());
    this.use(new TurnBased());
    this.use(new Physics());
    this.use(new CueShot());
    this.use(new Terminal());
    this.use(new StatusOffline());
    this.use(new ScoreboardUI());
    this.on("activate", this.handleActivate);
  }

  handleActivate = () => {
    // Initialize players for offline hotseat
    this.context.players = [
      { id: "player1", name: "Player 1" },
      { id: "player2", name: "Player 2" }
    ];
    
    this.context.gameStarted = true;
    this.emit("game-start");
  };
}
