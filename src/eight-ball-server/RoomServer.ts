import { Middleware } from "polymatic";

import { type ServerBilliardContext, type Auth } from "./ServerContext";

/**
 * This runs on server and is responsible for sending data to clients, and receiving user actions from clients.
 */
export class RoomServer extends Middleware<ServerBilliardContext> {
  inactiveRoomTimeout: any;
  lastUpdateTime: number = 0;
  updateInterval: number = 50; // Send updates every 50ms (20 times per second) instead of every frame

  constructor() {
    super();
    this.on("activate", this.handleActivate);
    this.on("deactivate", this.handleDeactivate);
    this.on("frame-loop", this.handleFrameLoop);

    this.on("update", this.handleUpdate);
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
        
        // Capture ball positions BEFORE physics starts
        const ballPositions = this.context.balls?.map(b => ({
          key: b.key,
          x: b.position.x,
          y: b.position.y
        })) || [];
        
        // Broadcast to OTHER clients immediately (before local physics)
        socket.broadcast.emit("shot-broadcast", {
          visibleShot: data.shot,
          ballPositions: ballPositions
        });
        
        // Now apply physics locally on server
        this.emit("cue-shot", data);

        this.extendRoomLease();
      });

      // Relay aim updates to other players so they can see opponent aiming
      socket.on("aim-update", (data) => {
        if (this.context.turn.current !== player.turn) return;
        // Broadcast to all OTHER clients (not the sender)
        socket.broadcast.emit("opponent-aim", data);
      });

      // Relay power updates so opponents see pullback animation
      socket.on("power-update", (data) => {
        if (this.context.turn.current !== player.turn) return;
        socket.broadcast.emit("opponent-power", data);
      });

      // Send current game state to the newly connected player
      this.sendStateToSocket(socket);

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
    // Shot broadcast now happens immediately in the socket handler before physics
    // This ensures opponents get pre-physics ball positions
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

  // Send full game state to a specific socket (used when player first connects)
  sendStateToSocket = (socket: any) => {
    const { rails, pockets, table, players, balls, shotInProgress, gameOver, gameStarted, turn, winner, turnStartTime } = this.context;
    const compactBalls = balls?.map(b => ({
      type: b.type,
      key: b.key,
      position: { x: Math.round(b.position.x * 100) / 100, y: Math.round(b.position.y * 100) / 100 },
      color: b.color,
      radius: b.radius
    }));
    socket.emit("room-update", {
      rails,
      pockets,
      table,
      players,
      balls: compactBalls,
      gameStarted,
      shotInProgress,
      gameOver,
      turn,
      winner,
      turnStartTime,
    });
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

  handleUpdate = () => {
    // Send state updates (called after turn changes, ball pocketing, etc.)
    this.sendMovingObjects();
  };
}
