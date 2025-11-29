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
  };

  handleDeactivate = () => {
    this.statusElement.innerText = "";
    this.waitingRoom?.classList.add("hidden");
    this.io?.disconnect();
  };

  handleServerRoomState = (data: any) => {
    const wasGameStarted = this.context.gameStarted;
    Object.assign(this.context, data);
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
