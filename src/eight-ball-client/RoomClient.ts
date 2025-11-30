import { Middleware } from "polymatic";
import { io, type Socket } from "socket.io-client";
import { nanoid } from "nanoid";

import { type Auth, type ClientBilliardContext } from "./ClientContext";

/**
 * This runs on client and is responsible for receiving data from server, and passing user actions to server.
 */
export class RoomClient extends Middleware<ClientBilliardContext> {
  io: Socket;
  statusElement: HTMLElement;
  connectionError: string;

  // Waiting room elements
  waitingRoom: HTMLElement;
  waitingRoomId: HTMLElement;
  copyRoomIdBtn: HTMLElement;
  playerSlot1: HTMLElement;
  playerSlot2: HTMLElement;
  waitingStatus: HTMLElement;
  leaveBtn: HTMLElement;

  constructor() {
    super();

    this.on("activate", this.handleActivate);
    this.on("deactivate", this.handleDeactivate);
    this.on("cue-shot", this.handleCueShot);
    this.on("game-start", this.handleGameStart);
    this.on("aim-update", this.handleAimUpdate);
    this.on("power-update", this.handlePowerUpdate);
    this.on("shot-end", this.handleShotEnd);
  }

  handleActivate = () => {
    this.statusElement = document.getElementById("room-status");
    this.printRoomStatus();

    // Set up waiting room elements
    this.waitingRoom = document.getElementById("waiting-room");
    this.waitingRoomId = document.getElementById("waiting-room-id");
    this.copyRoomIdBtn = document.getElementById("copy-room-id");
    this.playerSlot1 = document.getElementById("player-slot-1");
    this.playerSlot2 = document.getElementById("player-slot-2");
    this.waitingStatus = document.getElementById("waiting-status");
    this.leaveBtn = document.getElementById("leave-waiting-room");

    // Show waiting room and set room ID
    if (this.waitingRoom) {
      this.waitingRoom.classList.remove("hidden");
      console.log("Showing waiting room for room:", this.context.room);
    }
    if (this.waitingRoomId) {
      this.waitingRoomId.textContent = this.context.room || "---";
    }

    // Set up copy button
    this.copyRoomIdBtn?.addEventListener("click", this.handleCopyRoomId);
    this.leaveBtn?.addEventListener("click", this.handleLeaveRoom);

    // set up auth id and secret
    // id is public and will be shared by other users, secret is private
    const auth = {} as Auth;
    // For testing purposes, we generate a new ID every time to avoid "duplicate tab" issues
    // auth.id = sessionStorage.getItem("auth-id");
    // auth.secret = sessionStorage.getItem("auth-secret");
    if (!auth.id || !auth.secret) {
      auth.id = "player-" + nanoid(8);
      auth.secret = "secret-" + nanoid(8);
      // sessionStorage.setItem("auth-id", auth.id);
      // sessionStorage.setItem("auth-secret", auth.secret);
    }

    this.context.auth = auth;

    const room = this.context.room;
    this.io = io("/room/" + room, {
      auth: auth,
    });

    this.io.on("connect_error", (err) => {
      console.log("connect_error", err.message, err.message === "Invalid namespace");
      if (err.message === "Invalid namespace") {
        this.connectionError = "Room not found!";
      } else {
        this.connectionError = "Connection error: " + err.message;
      }
      this.printRoomStatus();
    });

    this.io.on("connect_failed", (err) => {
      console.log("connect_failed", err);
      this.connectionError = "Connection failed: " + err.message;
    });

    this.io.on("connect", () => {
      console.log("connected to room", room);
      this.connectionError = null;
      this.printRoomStatus();
    });
    this.io.on("room-update", this.handleServerRoomState);
    this.io.on("shot-broadcast", this.handleShotBroadcast);
    this.io.on("opponent-aim", this.handleOpponentAim);
    this.io.on("opponent-power", this.handleOpponentPower);
  };

  handleDeactivate = () => {
    this.statusElement.innerText = "";
    this.waitingRoom?.classList.add("hidden");
    this.io?.disconnect();
  };

  handleServerRoomState = (data: any) => {
    const wasGameStarted = this.context.gameStarted;
    
    // Don't overwrite balls during local physics simulation
    // Only accept ball updates when shot is NOT in progress (final sync)
    if (this.context.shotInProgress && data.balls) {
      // Skip ball updates during shot - we're running physics locally
      const { balls, ...rest } = data;
      Object.assign(this.context, rest);
    } else {
      // When not in shot, sync balls from server
      if (data.balls && Array.isArray(data.balls)) {
        // If client has no balls yet, just use server's balls directly
        if (!this.context.balls || this.context.balls.length === 0) {
          this.context.balls = data.balls;
        } else {
          // Update existing balls or add new ones, remove ones not in server list
          const serverBallKeys = new Set(data.balls.map((b: any) => b.key));
          
          // Remove balls that server doesn't have (pocketed)
          this.context.balls = this.context.balls.filter(b => serverBallKeys.has(b.key));
          
          // Update positions of remaining balls and add any missing ones
          for (const serverBall of data.balls) {
            const localBall = this.context.balls.find(b => b.key === serverBall.key);
            if (localBall) {
              localBall.position.x = serverBall.position.x;
              localBall.position.y = serverBall.position.y;
            } else {
              // Ball doesn't exist locally, add it
              this.context.balls.push(serverBall);
            }
          }
        }
      }
      
      // Copy other properties (rails, pockets, table, etc.)
      const { balls, ...rest } = data;
      Object.assign(this.context, rest);
    }
    
    if (Array.isArray(data.players) && this.context.auth) {
      this.context.player = data.players.find((p) => p.id === this.context.auth.id);
    }
    
    // Update waiting room UI
    this.updateWaitingRoom();
    
    // Emit game-start when the game first starts
    if (!wasGameStarted && data.gameStarted) {
      this.emit("game-start");
    }
  };

  handleGameStart = () => {
    // Hide waiting room when game starts
    this.waitingRoom?.classList.add("hidden");
  };

  handleCueShot = (data: object) => {
    this.io?.emit("cue-shot", data);
  };

  handleAimUpdate = (data: { aimX: number; aimY: number }) => {
    this.io?.emit("aim-update", data);
  };

  handlePowerUpdate = (data: { power: number }) => {
    this.io?.emit("power-update", data);
  };

  handleOpponentAim = (data: { aimX: number; aimY: number }) => {
    // Store opponent's aim so we can show their cue stick
    this.context.opponentAim = { x: data.aimX, y: data.aimY };
    this.context.opponentAiming = true;
  };

  handleOpponentPower = (data: { power: number }) => {
    // Store opponent's power for pullback animation
    this.context.opponentPower = data.power;
  };

  handleShotBroadcast = (data: { visibleShot: { x: number; y: number }; ballPositions: Array<{ key: string; x: number; y: number }> }) => {
    // Clear opponent aiming state - they've shot
    this.context.opponentAiming = false;
    this.context.opponentPower = 0;
    
    // Sync ball positions from server (these are now PRE-physics positions)
    if (data.ballPositions && this.context.balls) {
      for (const bp of data.ballPositions) {
        const ball = this.context.balls.find(b => b.key === bp.key);
        if (ball) {
          ball.position.x = bp.x;
          ball.position.y = bp.y;
        }
      }
    }
    
    // Find cue ball and apply shot locally - physics starts immediately
    const cueBall = this.context.balls?.find(b => b.color === 'white');
    if (cueBall && data.visibleShot) {
      // Force shotInProgress to false to ensure Physics accepts the new shot
      // (In case a server update arrived first and set it to true)
      this.context.shotInProgress = false;
      this.emit("cue-shot", { ball: cueBall, shot: data.visibleShot });
    }
  };
  
  // Listen for shot-end to clear spectating flag  
  handleShotEnd = () => {
    (this.context as any).spectatingShot = false;
  };

  handleCopyRoomId = () => {
    const roomId = this.context.room;
    if (roomId) {
      navigator.clipboard.writeText(roomId).then(() => {
        this.copyRoomIdBtn.textContent = "✓ Copied!";
        this.copyRoomIdBtn.classList.add("copied");
        setTimeout(() => {
          this.copyRoomIdBtn.textContent = "📋 Copy";
          this.copyRoomIdBtn.classList.remove("copied");
        }, 2000);
      });
    }
  };

  handleLeaveRoom = () => {
    this.emit("deactivate");
  };

  updateWaitingRoom = () => {
    const players = this.context.players || [];
    const myId = this.context.auth?.id;
    
    // Update player slots
    const slot1Name = this.playerSlot1.querySelector(".player-slot-name");
    const slot1Status = this.playerSlot1.querySelector(".player-slot-status");
    const slot2Name = this.playerSlot2.querySelector(".player-slot-name");
    const slot2Status = this.playerSlot2.querySelector(".player-slot-status");

    // Reset slots
    this.playerSlot1.classList.remove("joined", "you");
    this.playerSlot2.classList.remove("joined", "you");
    slot1Name.textContent = "Waiting...";
    slot1Status.textContent = "";
    slot2Name.textContent = "Waiting...";
    slot2Status.textContent = "";

    // Fill in player info
    players.forEach((player, index) => {
      const slot = index === 0 ? this.playerSlot1 : this.playerSlot2;
      const nameEl = slot.querySelector(".player-slot-name");
      const statusEl = slot.querySelector(".player-slot-status");

      const isYou = player.id === myId;
      slot.classList.add(isYou ? "you" : "joined");
      nameEl.textContent = isYou ? "You" : `Player ${index + 1}`;
      statusEl.textContent = isYou ? "(You)" : "Ready";
    });

    // Update waiting status
    const playersNeeded = 2;
    if (players.length >= playersNeeded) {
      this.waitingStatus.classList.add("ready");
      this.waitingStatus.innerHTML = "<span>✓ Both players joined! Starting game...</span>";
    } else {
      this.waitingStatus.classList.remove("ready");
      this.waitingStatus.innerHTML = `<div class="spinner"></div><span>Waiting for opponent to join... (${players.length}/${playersNeeded})</span>`;
    }
  };

  printRoomStatus = () => {
    this.statusElement.innerText = this.connectionError;
  };
}
