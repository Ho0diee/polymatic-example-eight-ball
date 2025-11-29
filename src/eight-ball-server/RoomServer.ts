import { Middleware } from "polymatic";

import { type ServerBilliardContext, type Auth } from "./ServerContext";

/**
 * This runs on server and is responsible for sending data to clients, and receiving user actions from clients.
 */
export class RoomServer extends Middleware<ServerBilliardContext> {
  inactiveRoomTimeout: any;
  lastUpdateTime: number = 0;
  updateInterval: number = 50; // Send updates every 50ms (20 times per second) instead of every frame
  pendingShot: { x: number; y: number } | null = null;

  constructor() {
    super();
    this.on("activate", this.handleActivate);
    this.on("deactivate", this.handleDeactivate);
    this.on("frame-loop", this.handleFrameLoop);

    this.on("update", this.sendFixedObjects);
    this.on("shot-start", this.handleShotStart);
    this.on("shot-end", this.handleShotEnd);

    this.on("user-enter", this.handleUserEnter);
    this.on("user-exit", this.handleUserExit);
  }

  handleActivate() {
    this.extendRoomLease();

    this.context.io.on("connection", (socket) => {
      const auth = { ...socket.handshake.auth } as Auth;

      const room = this.context.room;

      if (!room || !auth) return;

      let record = this.context.auths.find((p) => p.id === auth.id);

      if (!record) {
        record = { id: auth.id, secret: auth.secret };
        this.context.auths.push(record);
      } else if (record.secret !== auth.secret) {
        return;
      }

      let player = this.context.players.find((p) => p.id === auth.id);
      if (!player) {
        player = { id: auth.id };
        this.context.players.push(player);
      }

      console.log(`Player ${player.id} joined room ${this.context.room?.id}. Total players: ${this.context.players.length}`);

      this.emit("user-enter", { player });

      socket.on("cue-shot", (data) => {
        if (this.context.turn.current !== player.turn) return;
        // Store shot for broadcasting
        this.pendingShot = data.shot;
        this.emit("cue-shot", data);

        this.extendRoomLease();
      });

      this.sendFixedObjects();

      socket.on("exit-room", (data) => {
        this.context.players = this.context.players.filter((p) => p.id !== player.id);
        this.emit("user-exit", { player });
      });

      socket.on("disconnect", () => {
        this.emit("user-exit", { player });
      });
    });
  }

  handleDeactivate = () => {
    clearTimeout(this.inactiveRoomTimeout);

    const io = this.context.io;
    if (io) {
      this.context.io = null;
      io.removeAllListeners("connection");
      io.local.disconnectSockets();
      io.server._nsps.delete(io.name);
    }
  };

  extendRoomLease = () => {
    clearTimeout(this.inactiveRoomTimeout);
    this.inactiveRoomTimeout = setTimeout(this.expireRoomLease, 30 * 60 * 1000);
  };

  expireRoomLease = () => {
    this.emit("terminate-room");
  };

  handleFrameLoop() {
    // No longer streaming ball positions during shots - clients run physics locally
  }

  handleShotStart = () => {
    // Broadcast shot to all clients so they can run physics locally
    if (this.pendingShot) {
      const ballPositions = this.context.balls?.map(b => ({
        key: b.key,
        x: b.position.x,
        y: b.position.y
      })) || [];
      
      this.context.io.emit("shot-broadcast", {
        visibleShot: this.pendingShot,
        ballPositions: ballPositions
      });
      this.pendingShot = null;
    }
  };

  sendMovingObjects = () => {
    const { balls, shotInProgress, gameOver, gameStarted, turn, winner, turnStartTime, players } = this.context;
    // Only send essential ball data to reduce payload size
    const compactBalls = balls?.map(b => ({
      type: b.type,
      key: b.key,
      position: { x: Math.round(b.position.x * 100) / 100, y: Math.round(b.position.y * 100) / 100 },
      color: b.color,
      radius: b.radius
    }));
    this.context.io.emit("room-update", {
      balls: compactBalls,
      players,
      gameStarted,
      shotInProgress,
      gameOver,
      turn,
      winner,
      turnStartTime,
    });
  };

  sendFixedObjects = () => {
    const { rails, pockets, table, players } = this.context;
    this.context.io.emit("room-update", {
      players,
      rails,
      pockets,
      table,
    });
    this.sendMovingObjects();
  };

  handleUserEnter = () => {
    const playersJoined = this.context.players.length >= this.context.turn.turns.length;
    const notStarted = !this.context.gameStarted;
    if (playersJoined && notStarted) {
      this.context.gameStarted = true;
      this.emit("game-start");
      this.sendMovingObjects(); // Notify clients the game has started
    }
  };

  handleUserExit = (data: { player: any }) => {
    if (!this.context.gameStarted) {
      this.context.players = this.context.players.filter((p) => p.id !== data.player.id);
      this.sendFixedObjects();
    }
  };

  handleShotEnd = () => {
    // Send final authoritative state after shot completes
    // This syncs any drift between client physics simulations
    this.sendMovingObjects();
  };
}
