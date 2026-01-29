import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });


const express = require("express");
const path = require("path");

const app = express();

// Serve static files from the repo root (so /index.html, /script.js, /style.css work)
app.use(express.static(__dirname));

// Make / return index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// IMPORTANT for Render/hosting: use process.env.PORT and bind 0.0.0.0
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on ${PORT}`);
});


/**
 * Room state lives ONLY on server.
 * We send each client a "sanitized view": their own numbers visible, opponent numbers hidden
 * except when a piece is captured (then we reveal that captured number in the log event).
 */

const SIZE = 7;
const COLORS = ["Red","Orange","Yellow","Green","Blue","Navy","Purple"];
const HOME_COLS = { 1: [0,1], 2: [5,6] };
const TARGET_COL = { 1: 5, 2: 1 };
const TARGET_ROWS = new Set([1,2,3,4,5]);

const rooms = new Map(); // roomCode -> room object

function randCode(len=5){
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s="";
  for(let i=0;i<len;i++) s+=chars[Math.floor(Math.random()*chars.length)];
  return s;
}

function freshRoom(code){
  return {
    code,
    sockets: { 1: null, 2: null },
    // phases: WAITING -> NUMBERS -> PLACEMENT -> PLAY -> GAME_OVER
    phase: "WAITING",
    currentPlayer: 1,
    // for setup sequencing
    setupStep: "P1_NUMBERS", // P1_NUMBERS -> P1_PLACE -> P2_NUMBERS -> P2_PLACE -> PLAY
    pieces: {
      1: COLORS.map((c,i)=>({ id:i, color:c, n:null, pos:null, alive:true })),
      2: COLORS.map((c,i)=>({ id:i, color:c, n:null, pos:null, alive:true }))
    },
    maxN: {1:null, 2:null},
    capturedBy: {1:0, 2:0},
    rounds: 0,
    zone: {
      1: { pieceKey: null, streak: 0 },
      2: { pieceKey: null, streak: 0 }
    },
    log: [],
    gameOverMsg: null
  };
}

function pieceKey(p,id){ return `P${p}-${id}`; }
function inBounds(r,c){ return r>=0 && r<SIZE && c>=0 && c<SIZE; }
function keyPos(r,c){ return `${r},${c}`; }

function getPieceAt(room, r,c){
  for (const p of [1,2]){
    for (const pc of room.pieces[p]){
      if (pc.alive && pc.pos && pc.pos.r===r && pc.pos.c===c) return { player:p, piece:pc };
    }
  }
  return null;
}

function computeMax(room, p){
  room.maxN[p] = Math.max(...room.pieces[p].map(x=>x.n));
}

function isTargetSquareFor(player, r,c){
  return c === TARGET_COL[player] && TARGET_ROWS.has(r);
}

function compareWithSpecial(room, aPlayer, aN, bPlayer, bN){
  const aIsMax = (aN === room.maxN[aPlayer]);
  const bIsMax = (bN === room.maxN[bPlayer]);

  if (aIsMax && bN === 1) return -1;
  if (bIsMax && aN === 1) return +1;

  if (aN > bN) return +1;
  if (aN < bN) return -1;
  return 0;
}

// BFS reachability for "up to n adjacent steps, turning allowed, no stepping onto occupied squares"
function reachableSquares(room, startR, startC, steps){
  const seen = new Set([keyPos(startR,startC)]);
  const q = [{ r:startR, c:startC, d:0 }];
  const out = new Set();

  const dirs = [{dr:-1,dc:0},{dr:1,dc:0},{dr:0,dc:-1},{dr:0,dc:1}];

  while(q.length){
    const cur = q.shift();
    if (cur.d === steps) continue;

    for (const dir of dirs){
      const rr = cur.r + dir.dr;
      const cc = cur.c + dir.dc;
      if (!inBounds(rr,cc)) continue;

      const k = keyPos(rr,cc);
      if (seen.has(k)) continue;

      if (getPieceAt(room, rr, cc)) continue; // can't step onto occupied

      seen.add(k);
      out.add(k);
      q.push({ r:rr, c:cc, d:cur.d+1 });
    }
  }
  return out;
}

function resolveBattles(room){
  // simultaneous adjacency removals
  const toRemove = new Set();
  const dirs = [{dr:-1,dc:0},{dr:1,dc:0},{dr:0,dc:-1},{dr:0,dc:1}];

  const alivePieces = [];
  for (const p of [1,2]){
    for (const pc of room.pieces[p]){
      if (pc.alive && pc.pos) alivePieces.push({player:p, pc});
    }
  }

  for (const A of alivePieces){
    for (const d of dirs){
      const rr = A.pc.pos.r + d.dr;
      const cc = A.pc.pos.c + d.dc;
      if (!inBounds(rr,cc)) continue;
      const Bocc = getPieceAt(room, rr, cc);
      if (!Bocc) continue;
      if (Bocc.player === A.player) continue;

      const aK = pieceKey(A.player, A.pc.id);
      const bK = pieceKey(Bocc.player, Bocc.piece.id);
      if (aK > bK) continue; // process each edge once

      const cmp = compareWithSpecial(room, A.player, A.pc.n, Bocc.player, Bocc.piece.n);
      if (cmp === +1) toRemove.add(bK);
      else if (cmp === -1) toRemove.add(aK);
    }
  }

  // apply removals
  for (const k of toRemove){
    const [pStr, idStr] = k.split("-");
    const p = Number(pStr.replace("P",""));
    const id = Number(idStr);
    const pc = room.pieces[p][id];
    if (!pc.alive) continue;

    pc.alive = false;
    pc.pos = null;

    const captor = (p===1?2:1);
    room.capturedBy[captor] += 1;

    // captured number revealed in log to both
    room.log.push(`CAPTURE: Player ${captor} removed Player ${p}'s ${pc.color} (n=${pc.n}).`);

    // clear zone tracker if needed
    for (const pl of [1,2]){
      if (room.zone[pl].pieceKey === k){
        room.zone[pl].pieceKey = null;
      }
    }
  }
}

function evaluateZoneStreaks(room){
  for (const pl of [1,2]){
    const candidates = [];
    for (const pc of room.pieces[pl]){
      if (pc.alive && pc.pos && isTargetSquareFor(pl, pc.pos.r, pc.pos.c)){
        candidates.push(pc);
      }
    }

    if (candidates.length === 0){
      room.zone[pl].pieceKey = null;
      room.zone[pl].streak = 0;
      continue;
    }

    const tracked = room.zone[pl].pieceKey;
    const stillThere = tracked && candidates.some(pc => pieceKey(pl, pc.id) === tracked);

    if (stillThere){
      room.zone[pl].streak += 1;
    } else {
      candidates.sort((a,b)=>a.id-b.id);
      room.zone[pl].pieceKey = pieceKey(pl, candidates[0].id);
      room.zone[pl].streak = 1;
    }
  }
}

function checkWin(room){
  if (room.capturedBy[1] >= 4){
    room.phase = "GAME_OVER";
    room.gameOverMsg = "Player 1 wins by capturing 4 enemy pieces.";
    room.log.push("== GAME OVER ==");
    room.log.push(room.gameOverMsg);
    return true;
  }
  if (room.capturedBy[2] >= 4){
    room.phase = "GAME_OVER";
    room.gameOverMsg = "Player 2 wins by capturing 4 enemy pieces.";
    room.log.push("== GAME OVER ==");
    room.log.push(room.gameOverMsg);
    return true;
  }
  for (const pl of [1,2]){
    if (room.zone[pl].streak >= 4){
      room.phase = "GAME_OVER";
      room.gameOverMsg = `Player ${pl} wins by holding the target zone for 4 full rounds.`;
      room.log.push("== GAME OVER ==");
      room.log.push(room.gameOverMsg);
      return true;
    }
  }
  return false;
}

function sanitizedView(room, viewer){ // viewer = 1 or 2
  const opp = viewer===1 ? 2 : 1;

  const piecesView = {};
  for (const p of [1,2]){
    piecesView[p] = room.pieces[p].map(pc => ({
      id: pc.id,
      color: pc.color,
      alive: pc.alive,
      pos: pc.pos,
      n: (p === viewer) ? pc.n : null  // hide opponent numbers
    }));
  }

  return {
    code: room.code,
    phase: room.phase,
    setupStep: room.setupStep,
    currentPlayer: room.currentPlayer,
    pieces: piecesView,
    capturedBy: room.capturedBy,
    rounds: room.rounds,
    zone: room.zone,
    log: room.log.slice(-200),
    gameOverMsg: room.gameOverMsg
  };
}

function broadcast(room){
  for (const p of [1,2]){
    const ws = room.sockets[p];
    if (ws && ws.readyState === ws.OPEN){
      ws.send(JSON.stringify({ type:"STATE", state: sanitizedView(room, p), youAre:p }));
    }
  }
}

function safeSend(ws, obj){
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }

    if (msg.type === "CREATE_ROOM"){
      let code;
      do { code = randCode(5); } while(rooms.has(code));
      const room = freshRoom(code);
      room.phase = "NUMBERS";
      room.setupStep = "P1_NUMBERS";
      rooms.set(code, room);
      safeSend(ws, { type:"ROOM_CREATED", code });
      return;
    }

    if (msg.type === "JOIN_ROOM"){
      const code = String(msg.code || "").toUpperCase().replace(/[^A-Z0-9]/g,"");
      const room = rooms.get(code);
      if (!room){
        safeSend(ws, { type:"ERROR", message:"Room not found." });
        return;
      }
      let assigned = null;
      if (!room.sockets[1]) assigned = 1;
      else if (!room.sockets[2]) assigned = 2;
      else {
        safeSend(ws, { type:"ERROR", message:"Room is full." });
        return;
      }

      room.sockets[assigned] = ws;
      ws._roomCode = code;
      ws._player = assigned;

      room.log.push(`== Player ${assigned} joined ==`);

      if (room.sockets[1] && room.sockets[2]){
        room.log.push("== Both players connected. Begin setup. ==");
      }

      broadcast(room);
      return;
    }

    // For all other actions, must be in a room
    const code = ws._roomCode;
    const you = ws._player;
    if (!code || !you) return;
    const room = rooms.get(code);
    if (!room) return;

    if (msg.type === "SUBMIT_NUMBERS"){
      if (room.phase === "GAME_OVER") return;

      const nums = msg.nums;
      if (!Array.isArray(nums) || nums.length !== 7){
        safeSend(ws, { type:"ERROR", message:"Need 7 numbers." });
        return;
      }
      if (nums.some(v => !Number.isInteger(v) || v<=0)){
        safeSend(ws, { type:"ERROR", message:"All numbers must be positive integers." });
        return;
      }
      const sum = nums.reduce((a,b)=>a+b,0);
      if (sum !== 15){
        safeSend(ws, { type:"ERROR", message:`Numbers must sum to 15 (currently ${sum}).` });
        return;
      }

      if (room.setupStep === "P1_NUMBERS" && you !== 1){
        safeSend(ws, { type:"ERROR", message:"Waiting for Player 1 to submit numbers." });
        return;
      }
      if (room.setupStep === "P2_NUMBERS" && you !== 2){
        safeSend(ws, { type:"ERROR", message:"Waiting for Player 2 to submit numbers." });
        return;
      }

      room.pieces[you].forEach((pc,i)=>pc.n = nums[i]);
      computeMax(room, you);
      room.log.push(`== Player ${you} submitted numbers (hidden). max=${room.maxN[you]} ==`);

      // advance to placement
      room.setupStep = (you===1) ? "P1_PLACE" : "P2_PLACE";
      broadcast(room);
      return;
    }

    if (msg.type === "PLACE_PIECE"){
      if (room.phase === "GAME_OVER") return;

      const { r,c } = msg;
      if (!Number.isInteger(r) || !Number.isInteger(c) || !inBounds(r,c)){
        safeSend(ws, { type:"ERROR", message:"Bad coordinates." });
        return;
      }

      const expected = (you===1) ? "P1_PLACE" : "P2_PLACE";
      if (room.setupStep !== expected){
        safeSend(ws, { type:"ERROR", message:"Not your placement step." });
        return;
      }

      if (!HOME_COLS[you].includes(c)){
        safeSend(ws, { type:"ERROR", message:`You can only place in columns ${HOME_COLS[you].join(" & ")}.` });
        return;
      }
      if (getPieceAt(room, r,c)){
        safeSend(ws, { type:"ERROR", message:"Square occupied." });
        return;
      }

      const next = room.pieces[you].find(p => p.alive && p.pos==null);
      if (!next){
        safeSend(ws, { type:"ERROR", message:"All pieces already placed." });
        return;
      }

      next.pos = { r,c };
      room.log.push(`SETUP: Player ${you} placed ${next.color}.`);

      // if finished placing, advance setup step
      const done = room.pieces[you].every(p => p.pos != null);
      if (done){
        room.log.push(`== Player ${you} finished placement ==`);
        if (you===1){
          room.setupStep = "P2_NUMBERS";
        } else {
          room.setupStep = "PLAY";
          room.phase = "PLAY";
          room.currentPlayer = 1;
          room.log.push("== Game start. Player 1 to move. ==");
        }
      }

      broadcast(room);
      return;
    }

    if (msg.type === "MOVE"){
      if (room.phase !== "PLAY") return;
      if (room.currentPlayer !== you){
        safeSend(ws, { type:"ERROR", message:"Not your turn." });
        return;
      }

      const { pieceId, toR, toC } = msg;
      if (!Number.isInteger(pieceId) || pieceId<0 || pieceId>6) {
        safeSend(ws, { type:"ERROR", message:"Bad piece id." });
        return;
      }
      if (!Number.isInteger(toR) || !Number.isInteger(toC) || !inBounds(toR,toC)){
        safeSend(ws, { type:"ERROR", message:"Bad destination." });
        return;
      }

      const pc = room.pieces[you][pieceId];
      if (!pc.alive || !pc.pos){
        safeSend(ws, { type:"ERROR", message:"That piece is not available." });
        return;
      }
      if (getPieceAt(room, toR,toC)){
        safeSend(ws, { type:"ERROR", message:"Destination occupied." });
        return;
      }

      const reach = reachableSquares(room, pc.pos.r, pc.pos.c, pc.n);
      if (!reach.has(keyPos(toR,toC))){
        safeSend(ws, { type:"ERROR", message:`Illegal move. Must be reachable in ≤ ${pc.n} adjacent steps.` });
        return;
      }

      pc.pos = { r:toR, c:toC };
      room.log.push(`MOVE: Player ${you} moved ${pc.color}.`);

      resolveBattles(room);

      if (checkWin(room)){
        broadcast(room);
        return;
      }

      // switch turn
      const prev = room.currentPlayer;
      room.currentPlayer = (prev===1 ? 2 : 1);

      // end of full round after Player 2 moves (when next turn becomes 1)
      if (room.currentPlayer === 1){
        room.rounds += 1;
        evaluateZoneStreaks(room);
        if (checkWin(room)){
          broadcast(room);
          return;
        }
      }

      broadcast(room);
      return;
    }

    if (msg.type === "RESET_ROOM"){
      // allow either player to reset
      const newRoom = freshRoom(code);
      newRoom.phase = "NUMBERS";
      newRoom.setupStep = "P1_NUMBERS";
      newRoom.sockets = room.sockets; // keep connections
      newRoom.log.push("== Room reset ==");
      rooms.set(code, newRoom);
      broadcast(newRoom);
      return;
    }
  });

  ws.on("close", () => {
    const code = ws._roomCode;
    const you = ws._player;
    if (!code || !you) return;
    const room = rooms.get(code);
    if (!room) return;

    room.sockets[you] = null;
    room.log.push(`== Player ${you} disconnected ==`);
    broadcast(room);

    // optional cleanup: if empty, delete room
    if (!room.sockets[1] && !room.sockets[2]){
      rooms.delete(code);
    }
  });
});
