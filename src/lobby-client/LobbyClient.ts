import { Runtime, Middleware } from "polymatic";
import { io, type Socket } from "socket.io-client";

import { MainClient } from "../eight-ball-client/MainClient";
import { MainOffline } from "../eight-ball-client/MainOffline";
import { isValidRoomId, normalizeRoomId } from "../lobby/RoomId";

export interface LobbyClientContext {
  // nothing
}

export class LobbyClient extends Middleware<LobbyClientContext> {
  playOfflineButton: HTMLElement;
  createRoomButton: HTMLElement;
  joinRoomButton: HTMLElement;
  roomCodeInput: HTMLInputElement;
  lobbyButtons: HTMLElement;

  io: Socket;

  room: MainOffline | MainClient;

  constructor() {
    super();

    this.on("activate", this.handleActivate);
  }

  handleActivate() {
    // set up buttons
    this.playOfflineButton = document.getElementById("play-offline");
    this.createRoomButton = document.getElementById("create-room");
    this.joinRoomButton = document.getElementById("join-room");
    this.roomCodeInput = document.getElementById("room-code-input") as HTMLInputElement;
    this.lobbyButtons = document.getElementById("lobby-buttons");

    this.playOfflineButton.addEventListener("click", this.handlePlayOffline);
    this.createRoomButton.addEventListener("click", this.handleCreateRoom);
    this.joinRoomButton.addEventListener("click", this.handleJoinRoom);
    
    // Allow pressing Enter in the input field to join
    this.roomCodeInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        this.handleJoinRoom();
      }
    });

    // Auto-format input as user types (add dashes)
    this.roomCodeInput.addEventListener("input", this.handleRoomCodeInput);

    // set up io connection and listeners
    this.io = io();
    this.io.on("connect", () => console.log("connected to lobby"));
    this.io.on("room-ready", this.handleRoomReady);
  }

  handleRoomCodeInput = () => {
    let value = this.roomCodeInput.value.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (value.length > 3) {
      value = value.slice(0, 3) + "-" + value.slice(3);
    }
    if (value.length > 7) {
      value = value.slice(0, 7) + "-" + value.slice(7);
    }
    if (value.length > 11) {
      value = value.slice(0, 11);
    }
    this.roomCodeInput.value = value;
  };

  handlePlayOffline = () => {
    if (this.room) {
      Runtime.deactivate(this.room);
      this.room = null;
    }
    this.lobbyButtons.style.display = "none";
    Runtime.activate((this.room = new MainOffline()), {});
  };

  handleCreateRoom = () => {
    this.io.emit("create-room");
  };

  handleRoomReady = ({ id }: { id: string }) => {
    if (this.room) {
      Runtime.deactivate(this.room);
      this.room = null;
    }

    localStorage.setItem("eight-ball-room", id);
    this.lobbyButtons.style.display = "none";
    
    const client = new MainClient();
    client.on("deactivate", this.handleRoomLeft);
    Runtime.activate((this.room = client), {
      room: id,
    });
  };

  handleJoinRoom = () => {
    const input = this.roomCodeInput.value.trim();
    if (!input) {
      this.roomCodeInput.focus();
      return;
    }

    const id = normalizeRoomId(input);

    if (!isValidRoomId(id)) {
      alert("Invalid room code. Format: xxx-xxx-xxx");
      this.roomCodeInput.focus();
      return;
    }

    if (this.room) {
      Runtime.deactivate(this.room);
      this.room = null;
    }

    localStorage.setItem("eight-ball-room", id);
    this.lobbyButtons.style.display = "none";
    
    const client = new MainClient();
    client.on("deactivate", this.handleRoomLeft);
    Runtime.activate((this.room = client), {
      room: id,
    });
  };

  handleRoomLeft = () => {
    this.room = null;
    this.lobbyButtons.style.display = "flex";
    this.roomCodeInput.value = "";
  };
}
