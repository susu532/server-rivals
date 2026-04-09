import express from "express";
import { createServer as createViteServer } from "vite";
import { Server as SocketIOServer } from "socket.io";
import http from "http";
import path from "path";
import * as CANNON from "cannon-es";

const PORT = Number(process.env.PORT) || 3000;
const TICK_RATE = 60;
const TICK_DT = 1 / TICK_RATE;

// Game State Interfaces
interface PlayerState {
  id: string;
  name: string;
  position: [number, number, number];
  velocity: [number, number, number];
  rotation: [number, number, number, number];
  color: string;
  team: 'red' | 'blue';
  score: number;
  lastKickTime: number;
  lastJumpTime: number;
  character: string;
  goals: number;
  assists: number;
  kicks: number;
  worldCupCountry?: string;
}

interface GameState {
  players: Record<string, PlayerState>;
  ball: {
    position: [number, number, number];
    velocity: [number, number, number];
    rotation: [number, number, number, number];
  };
  score: { red: number; blue: number };
  matchState: 'waiting' | 'playing' | 'goal' | 'gameover' | 'freeplay' | 'countdown';
  timer: number;
  message: string;
  isOvertime: boolean;
  isWorldCup: boolean;
  worldCupTeams?: { red: string; blue: string };
  lastScorer?: {
    name: string;
    team: 'red' | 'blue';
    country?: string;
  };
}

interface Room {
  id: string;
  isPrivate: boolean;
  isTraining: boolean;
  isWorldCup: boolean;
  difficulty: 'easy' | 'medium' | 'hard';
  botIds: string[];
  world: CANNON.World;
  gameState: GameState;
  playerBodies: Record<string, CANNON.Body>;
  playerInputs: Record<string, { x: number; z: number; kick: boolean; jump: boolean; cameraAngle: number }>;
  ballBody: CANNON.Body;
  playerMaterial: CANNON.Material;
  ticks: number;
  stateTimer: number;
  resetPositions: () => void;
  lastTouchId: string | null;
  secondLastTouchId: string | null;
}

const rooms = new Map<string, Room>();

function createRoom(roomId: string, isPrivate: boolean, isTraining: boolean = false, difficulty: 'easy' | 'medium' | 'hard' = 'medium', isWorldCup: boolean = false): Room {
  const world = new CANNON.World({
    gravity: new CANNON.Vec3(0, -9.82, 0),
  });

  // Materials
  const groundMaterial = new CANNON.Material('ground');
  const ballMaterial = new CANNON.Material('ball');
  const playerMaterial = new CANNON.Material('player');
  const wallMaterial = new CANNON.Material('wall');

  world.addContactMaterial(new CANNON.ContactMaterial(groundMaterial, ballMaterial, { friction: 1.0, restitution: 0.4 }));
  world.addContactMaterial(new CANNON.ContactMaterial(wallMaterial, ballMaterial, { friction: 0.5, restitution: 0.1 }));
  world.addContactMaterial(new CANNON.ContactMaterial(groundMaterial, playerMaterial, { friction: 0.0, restitution: 0.0 }));
  world.addContactMaterial(new CANNON.ContactMaterial(playerMaterial, ballMaterial, { friction: 0.2, restitution: 0.4 }));
  world.addContactMaterial(new CANNON.ContactMaterial(playerMaterial, wallMaterial, { friction: 0.0, restitution: 0.0 }));
  world.addContactMaterial(new CANNON.ContactMaterial(playerMaterial, playerMaterial, { friction: 0.1, restitution: 0.5 }));

  // Ground
  const groundBody = new CANNON.Body({
    type: CANNON.Body.STATIC,
    shape: new CANNON.Plane(),
    material: groundMaterial,
  });
  groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(groundBody);

  // Walls
  const fieldWidth = 30;
  const fieldLength = 40;
  const wallHeight = 20;
  const goalWidth = 8;
  const goalDepth = 2;
  const goalHeight = 3;

  const createWall = (x: number, y: number, z: number, width: number, height: number, depth: number) => {
    const wall = new CANNON.Body({
      type: CANNON.Body.STATIC,
      shape: new CANNON.Box(new CANNON.Vec3(width / 2, height / 2, depth / 2)),
      position: new CANNON.Vec3(x, y, z),
      material: wallMaterial,
    });
    world.addBody(wall);
  };

  const wallWidth = (fieldWidth - goalWidth) / 2;
  const wallOffset = goalWidth / 2 + wallWidth / 2;

  createWall(-wallOffset, wallHeight / 2, -fieldLength / 2, wallWidth, wallHeight, 1);
  createWall(wallOffset, wallHeight / 2, -fieldLength / 2, wallWidth, wallHeight, 1);
  createWall(0, goalHeight + (wallHeight - goalHeight) / 2, -fieldLength / 2, goalWidth, wallHeight - goalHeight, 1);
  
  createWall(-wallOffset, wallHeight / 2, fieldLength / 2, wallWidth, wallHeight, 1);
  createWall(wallOffset, wallHeight / 2, fieldLength / 2, wallWidth, wallHeight, 1);
  createWall(0, goalHeight + (wallHeight - goalHeight) / 2, fieldLength / 2, goalWidth, wallHeight - goalHeight, 1);

  createWall(-fieldWidth / 2, wallHeight / 2, 0, 1, wallHeight, fieldLength);
  createWall(fieldWidth / 2, wallHeight / 2, 0, 1, wallHeight, fieldLength);

  createWall(0, goalHeight / 2, -fieldLength / 2 - goalDepth, goalWidth, goalHeight, 1);
  createWall(-goalWidth / 2, goalHeight / 2, -fieldLength / 2 - goalDepth / 2, 1, goalHeight, goalDepth);
  createWall(goalWidth / 2, goalHeight / 2, -fieldLength / 2 - goalDepth / 2, 1, goalHeight, goalDepth);
  createWall(0, goalHeight, -fieldLength / 2 - goalDepth / 2, goalWidth, 1, goalDepth);

  createWall(0, goalHeight / 2, fieldLength / 2 + goalDepth, goalWidth, goalHeight, 1);
  createWall(-goalWidth / 2, goalHeight / 2, fieldLength / 2 + goalDepth / 2, 1, goalHeight, goalDepth);
  createWall(goalWidth / 2, goalHeight / 2, fieldLength / 2 + goalDepth / 2, 1, goalHeight, goalDepth);
  createWall(0, goalHeight, fieldLength / 2 + goalDepth / 2, goalWidth, 1, goalDepth);

  createWall(0, wallHeight, 0, fieldWidth, 1, fieldLength + goalDepth * 2);

  // Ball
  const ballBody = new CANNON.Body({
    mass: 0.8,
    shape: new CANNON.Sphere(0.5),
    position: new CANNON.Vec3(0, 5, 0),
    material: ballMaterial,
    linearDamping: 0.5,
    angularDamping: 0.9,
  });
  world.addBody(ballBody);

  const gameState: GameState = {
    players: {},
    ball: { position: [0, 5, 0], velocity: [0, 0, 0], rotation: [0, 0, 0, 1] },
    score: { red: 0, blue: 0 },
    matchState: 'waiting',
    timer: 0,
    message: 'Waiting for players...',
    isOvertime: false,
    isWorldCup,
  };

  const playerBodies: Record<string, CANNON.Body> = {};
  
  const resetPositions = () => {
    ballBody.position.set(0, 5, 0);
    ballBody.velocity.set(0, 0, 0);
    ballBody.angularVelocity.set(0, 0, 0);

    const bluePlayers = Object.values(gameState.players).filter(p => p.team === 'blue');
    const redPlayers = Object.values(gameState.players).filter(p => p.team === 'red');

    let blueIdx = 0;
    let redIdx = 0;
    for (const id in playerBodies) {
      const p = playerBodies[id];
      const state = gameState.players[id];
      if (!state) continue;
      
      const isBlue = state.team === 'blue';
      const z = isBlue ? -10 : 10;
      
      let x = 0;
      if (isBlue) {
        const total = bluePlayers.length;
        const offset = (total - 1) * 2;
        x = (blueIdx++ * 4) - offset;
      } else {
        const total = redPlayers.length;
        const offset = (total - 1) * 2;
        x = (redIdx++ * 4) - offset;
      }
      
      p.position.set(x, 1, z);
      p.velocity.set(0, 0, 0);
      p.angularVelocity.set(0, 0, 0);
    }
  };

  return {
    id: roomId,
    isPrivate,
    isTraining,
    isWorldCup,
    difficulty,
    botIds: [],
    world,
    gameState,
    playerBodies,
    playerInputs: {},
    ballBody,
    playerMaterial,
    ticks: 0,
    stateTimer: 0,
    resetPositions,
    lastTouchId: null,
    secondLastTouchId: null,
  };
}

// Helper to generate random room code
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function addBot(room: Room, team: 'red' | 'blue') {
  const botId = `bot_${Math.random().toString(36).substring(2, 8)}`;
  const color = team === 'red' ? '#ff007f' : '#00ffff';
  const startZ = team === 'red' ? 10 : -10;

  const botBody = new CANNON.Body({
    mass: 5,
    shape: new CANNON.Box(new CANNON.Vec3(0.5, 1, 0.5)),
    position: new CANNON.Vec3((Math.random() - 0.5) * 10, 1, startZ),
    material: room.playerMaterial,
    fixedRotation: true,
    linearDamping: 0.9,
  });
  room.world.addBody(botBody);
  room.playerBodies[botId] = botBody;
  room.playerInputs[botId] = { x: 0, z: 0, kick: false, jump: false, cameraAngle: 0 };
  room.botIds.push(botId);

  room.gameState.players[botId] = {
    id: botId,
    name: `AI (${room.difficulty.toUpperCase()})`,
    position: [botBody.position.x, botBody.position.y, botBody.position.z],
    velocity: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    color,
    team,
    score: 0,
    lastKickTime: 0,
    lastJumpTime: 0,
    character: 'robot',
    goals: 0,
    assists: 0,
    kicks: 0,
  };

  return botId;
}

function updateBots(room: Room) {
  if (!room.isTraining || room.botIds.length === 0) return;

  const ballPos = room.ballBody.position;
  const reactionDelay = room.difficulty === 'easy' ? 30 : room.difficulty === 'medium' ? 15 : 5;

  for (const botId of room.botIds) {
    const botBody = room.playerBodies[botId];
    const botState = room.gameState.players[botId];
    if (!botBody || !botState) continue;

    // Only update input every few ticks based on difficulty
    if (room.ticks % reactionDelay !== 0) continue;

    const input = room.playerInputs[botId];
    const teamDir = botState.team === 'red' ? -1 : 1; // Red wants to push to negative Z, Blue to positive Z
    const opponentGoalZ = botState.team === 'red' ? -20 : 20;

    // Vector to ball
    const toBallX = ballPos.x - botBody.position.x;
    const toBallZ = ballPos.z - botBody.position.z;
    const distToBall = Math.sqrt(toBallX * toBallX + toBallZ * toBallZ);

    // AI Logic:
    // 1. If ball is behind us (relative to goal we are defending), go around it
    // 2. Otherwise, move towards ball
    // 3. If close to ball, kick towards goal

    let targetX = ballPos.x;
    let targetZ = ballPos.z;

    // If ball is "behind" the bot relative to the direction it should be pushing
    const isBallBehind = botState.team === 'red' ? (ballPos.z > botBody.position.z + 1) : (ballPos.z < botBody.position.z - 1);

    if (isBallBehind) {
      // Move to a position behind the ball first
      targetZ = ballPos.z + (botState.team === 'red' ? 3 : -3);
      // Add some horizontal offset to avoid running into the ball while repositioning
      if (Math.abs(toBallX) < 2) {
        targetX = ballPos.x + (toBallX > 0 ? -3 : 3);
      }
    }

    const dirX = targetX - botBody.position.x;
    const dirZ = targetZ - botBody.position.z;
    const dist = Math.sqrt(dirX * dirX + dirZ * dirZ);

    if (dist > 0.5) {
      input.x = dirX / dist;
      input.z = dirZ / dist;
    } else {
      input.x = 0;
      input.z = 0;
    }

    // Kicking logic
    if (distToBall < 2.5) {
      // Check if we are facing the right way to kick towards goal
      const toGoalX = 0 - botBody.position.x;
      const toGoalZ = opponentGoalZ - botBody.position.z;
      const dot = (toBallX * toGoalX + toBallZ * toGoalZ);
      
      if (dot > 0 || room.difficulty === 'hard') {
        input.kick = true;
        // Set camera angle for kick direction (towards goal)
        input.cameraAngle = Math.atan2(-toGoalX, -toGoalZ);
      }
    }

    // Random jumps for Hard difficulty
    if (room.difficulty === 'hard' && Math.random() < 0.01 && botBody.position.y < 1.1) {
      input.jump = true;
    }
  }
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new SocketIOServer(server, { cors: { origin: "*" } });

  const playerRooms = new Map<string, string>(); // socket.id -> roomId
  const matchmakingQueue: string[] = [];
  const worldCupQueue: string[] = [];

  const freePlayRoom = createRoom('FREEPLAY', false);
  freePlayRoom.gameState.matchState = 'freeplay';
  freePlayRoom.gameState.message = 'FREE PLAY\nWAITING FOR PLAYERS...';
  rooms.set('FREEPLAY', freePlayRoom);

  const worldCupFreePlayRoom = createRoom('WORLD_CUP_FREEPLAY', false, false, 'medium', true);
  worldCupFreePlayRoom.gameState.matchState = 'freeplay';
  worldCupFreePlayRoom.gameState.message = 'WORLD CUP LOBBY\nWAITING FOR TOURNAMENT...';
  rooms.set('WORLD_CUP_FREEPLAY', worldCupFreePlayRoom);

  function leaveRoom(socket: any) {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return;
    
    const queueIndex = matchmakingQueue.indexOf(socket.id);
    if (queueIndex !== -1) matchmakingQueue.splice(queueIndex, 1);
    
    const wcQueueIndex = worldCupQueue.indexOf(socket.id);
    if (wcQueueIndex !== -1) worldCupQueue.splice(wcQueueIndex, 1);

    const room = rooms.get(roomId);
    if (!room) return;

    if (room.playerBodies[socket.id]) {
      room.world.removeBody(room.playerBodies[socket.id]);
      delete room.playerBodies[socket.id];
    }
    delete room.playerInputs[socket.id];
    delete room.gameState.players[socket.id];
    
    socket.leave(roomId);
    io.to(roomId).emit("playerLeft", socket.id);
    playerRooms.delete(socket.id);

    if (Object.keys(room.gameState.players).length === 0 && roomId !== 'FREEPLAY' && roomId !== 'WORLD_CUP_FREEPLAY') {
      rooms.delete(roomId); // Clean up empty room
    } else if (roomId !== 'FREEPLAY' && roomId !== 'WORLD_CUP_FREEPLAY') {
      const blueCount = Object.values(room.gameState.players).filter(p => p.team === 'blue').length;
      const redCount = Object.values(room.gameState.players).filter(p => p.team === 'red').length;

      if ((room.gameState.matchState === 'playing' || room.gameState.matchState === 'countdown') && (blueCount === 0 || redCount === 0)) {
        room.gameState.matchState = 'gameover';
        if (blueCount === 0 && redCount > 0) {
          room.gameState.message = 'RED WINS (OPPONENT LEFT)!';
        } else if (redCount === 0 && blueCount > 0) {
          room.gameState.message = 'BLUE WINS (OPPONENT LEFT)!';
        } else {
          room.gameState.message = 'MATCH ENDED';
        }
        room.stateTimer = 5;
      }
    }
  }

  function joinRoom(socket: any, room: Room, name: string, worldCupCountry?: string) {
    socket.join(room.id);
    playerRooms.set(socket.id, room.id);

    const teamCount = Object.values(room.gameState.players).reduce(
      (acc, p) => { acc[p.team]++; return acc; },
      { red: 0, blue: 0 }
    );
    const team = teamCount.red <= teamCount.blue ? 'red' : 'blue';
    let color = team === 'red' ? '#ff007f' : '#00ffff';
    const startZ = team === 'red' ? 10 : -10;

    if (room.isWorldCup && worldCupCountry) {
      if (!room.gameState.worldCupTeams) {
        room.gameState.worldCupTeams = { red: '', blue: '' };
      }
      if (!room.gameState.worldCupTeams[team]) {
        room.gameState.worldCupTeams[team] = worldCupCountry;
      }
    }

    const playerBody = new CANNON.Body({
      mass: 5,
      shape: new CANNON.Box(new CANNON.Vec3(0.5, 1, 0.5)),
      position: new CANNON.Vec3((Math.random() - 0.5) * 10, 1, startZ),
      material: room.playerMaterial,
      fixedRotation: true,
      linearDamping: 0.9,
    });
    room.world.addBody(playerBody);
    room.playerBodies[socket.id] = playerBody;
    room.playerInputs[socket.id] = { x: 0, z: 0, kick: false, jump: false, cameraAngle: 0 };

    room.gameState.players[socket.id] = {
      id: socket.id,
      name: name || `Player ${socket.id.substring(0, 4)}`,
      position: [playerBody.position.x, playerBody.position.y, playerBody.position.z],
      velocity: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      color,
      team,
      score: 0,
      lastKickTime: 0,
      lastJumpTime: 0,
      character: 'robot',
      goals: 0,
      assists: 0,
      kicks: 0,
      worldCupCountry,
    };

    socket.emit("init", { id: socket.id, state: room.gameState, roomId: room.id, isPrivate: room.isPrivate });
    socket.to(room.id).emit("playerJoined", room.gameState.players[socket.id]);
  }

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("joinQueue", ({ name, worldCupCountry, isWorldCup }: { name: string, worldCupCountry?: string, isWorldCup?: boolean }) => {
      leaveRoom(socket);
      
      const queue = isWorldCup ? worldCupQueue : matchmakingQueue;
      
      // 1. Try to find an existing public match with space
      let targetRoom: Room | null = null;
      for (const room of rooms.values()) {
        if (room.id !== 'FREEPLAY' && room.id !== 'WORLD_CUP_FREEPLAY' && !room.isPrivate && room.isWorldCup === !!isWorldCup) {
          const playerCount = Object.keys(room.gameState.players).length;
          const maxPlayers = isWorldCup ? 2 : 4;
          if (playerCount < maxPlayers && room.gameState.matchState !== 'gameover') {
            targetRoom = room;
            break;
          }
        }
      }

      if (targetRoom) {
        console.log(`Filling existing ${isWorldCup ? 'World Cup ' : ''}room ${targetRoom.id} with player ${socket.id}`);
        joinRoom(socket, targetRoom, name, worldCupCountry);
      } else {
        // 2. Fallback to Freeplay + Queue
        const fpRoom = isWorldCup ? worldCupFreePlayRoom : freePlayRoom;
        joinRoom(socket, fpRoom, name, worldCupCountry);
        queue.push(socket.id);
      }
    });

    socket.on("createPrivateRoom", ({ name, worldCupCountry, isWorldCup }: { name: string, worldCupCountry?: string, isWorldCup?: boolean }) => {
      leaveRoom(socket);
      const newRoomId = generateRoomCode();
      const room = createRoom(newRoomId, true, false, 'medium', !!isWorldCup);
      room.gameState.matchState = 'freeplay';
      room.gameState.message = `ROOM: ${newRoomId}\nWAITING FOR PLAYERS...`;
      rooms.set(newRoomId, room);
      joinRoom(socket, room, name, worldCupCountry);
      socket.emit("roomCreated", newRoomId);
    });

    socket.on("startTraining", ({ name, difficulty, worldCupCountry, isWorldCup }: { name: string, difficulty: 'easy' | 'medium' | 'hard', worldCupCountry?: string, isWorldCup?: boolean }) => {
      leaveRoom(socket);
      const trainingRoomId = `TRAIN_${generateRoomCode()}`;
      const room = createRoom(trainingRoomId, true, true, difficulty, !!isWorldCup);
      rooms.set(trainingRoomId, room);
      
      // Join the human player
      joinRoom(socket, room, name, worldCupCountry);
      
      // Add the bot to the opposite team
      const humanPlayer = room.gameState.players[socket.id];
      const botTeam = humanPlayer.team === 'red' ? 'blue' : 'red';
      addBot(room, botTeam);
      
      socket.emit("roomCreated", trainingRoomId);
    });

    socket.on("joinPrivateRoom", ({ name, roomCode, worldCupCountry }: { name: string, roomCode: string, worldCupCountry?: string }) => {
      leaveRoom(socket);
      const room = rooms.get(roomCode.toUpperCase());
      if (room && room.isPrivate && Object.keys(room.gameState.players).length < 4) {
        joinRoom(socket, room, name, worldCupCountry);
        if (room.gameState.matchState === 'freeplay' && room.id !== 'FREEPLAY') {
          room.gameState.message = `ROOM: ${room.id}\nWAITING FOR PLAYERS...`;
        }
      } else {
        socket.emit("error", "Room not found or full");
      }
    });

    socket.on("leave", () => {
      leaveRoom(socket);
    });

    socket.on("input", (input: { x: number; z: number; kick: boolean; jump: boolean; cameraAngle: number }) => {
      const roomId = playerRooms.get(socket.id);
      if (roomId) {
        const room = rooms.get(roomId);
        if (room) {
          room.playerInputs[socket.id] = input;
        }
      }
    });

    socket.on("chat", (message: string) => {
      if (message.length > 100) return;
      const roomId = playerRooms.get(socket.id);
      if (roomId) {
        const room = rooms.get(roomId);
        if (room) {
          const player = room.gameState.players[socket.id];
          if (player) {
            io.to(roomId).emit("chat", {
              id: Date.now().toString(),
              playerId: socket.id,
              playerName: player.name,
              playerColor: player.color,
              message,
              timestamp: Date.now(),
            });
          }
        }
      }
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
      leaveRoom(socket);
    });
  });

  // Physics Loop
  setInterval(() => {
    // Matchmaking check: Try to fill existing rooms first
    const processQueue = (queue: string[], isWorldCup: boolean) => {
      if (queue.length > 0) {
        const playersToRemove: string[] = [];
        
        for (let i = 0; i < queue.length; i++) {
          const pid = queue[i];
          const s = io.sockets.sockets.get(pid);
          if (!s) {
            playersToRemove.push(pid);
            continue;
          }

          // Try to find a room for this queued player
          let targetRoom: Room | null = null;
          for (const room of rooms.values()) {
            if (room.id !== 'FREEPLAY' && room.id !== 'WORLD_CUP_FREEPLAY' && !room.isPrivate && room.isWorldCup === isWorldCup) {
              const playerCount = Object.keys(room.gameState.players).length;
              const maxPlayers = isWorldCup ? 2 : 4;
              if (playerCount < maxPlayers && room.gameState.matchState !== 'gameover') {
                targetRoom = room;
                break;
              }
            }
          }

          if (targetRoom) {
            const sourceRoom = isWorldCup ? worldCupFreePlayRoom : freePlayRoom;
            const name = sourceRoom.gameState.players[pid]?.name || 'Player';
            const worldCupCountry = sourceRoom.gameState.players[pid]?.worldCupCountry;
            leaveRoom(s);
            joinRoom(s, targetRoom, name, worldCupCountry);
            playersToRemove.push(pid);
          }
        }

        // Clean up queue
        for (const pid of playersToRemove) {
          const idx = queue.indexOf(pid);
          if (idx !== -1) queue.splice(idx, 1);
        }
      }

      // If still have enough for a new match
      if (queue.length >= 2) {
        const p1 = queue.shift()!;
        const p2 = queue.shift()!;
        
        const matchRoomId = generateRoomCode();
        const matchRoom = createRoom(matchRoomId, false, false, 'medium', isWorldCup);
        rooms.set(matchRoomId, matchRoom);

        const playersToMove = [p1, p2];
        const sourceRoom = isWorldCup ? worldCupFreePlayRoom : freePlayRoom;
        for (const pid of playersToMove) {
          const s = io.sockets.sockets.get(pid);
          if (s) {
            const name = sourceRoom.gameState.players[pid]?.name || 'Player';
            const worldCupCountry = sourceRoom.gameState.players[pid]?.worldCupCountry;
            leaveRoom(s);
            joinRoom(s, matchRoom, name, worldCupCountry);
          }
        }
      }
    };

    processQueue(matchmakingQueue, false);
    processQueue(worldCupQueue, true);

    for (const room of rooms.values()) {
      room.ticks++;
      
      // Update AI if in training mode
      if (room.isTraining) {
        updateBots(room);
      }

      if (room.ticks >= TICK_RATE) {
        room.ticks = 0;
        
        if (room.gameState.matchState === 'waiting' || (room.gameState.matchState === 'freeplay' && room.id !== 'FREEPLAY')) {
          if (Object.keys(room.gameState.players).length >= 2) {
            room.gameState.matchState = 'countdown';
            room.gameState.timer = 5;
            room.gameState.message = '';
            room.gameState.score = { red: 0, blue: 0 };
            room.gameState.isOvertime = false;
            delete room.gameState.lastScorer;
            room.resetPositions();
          }
        } else if (room.gameState.matchState === 'countdown') {
          room.gameState.timer--;
          if (room.gameState.timer <= 0) {
            room.gameState.matchState = 'playing';
            room.gameState.timer = 180;
            room.gameState.isOvertime = false;
          }
        } else if (room.gameState.matchState === 'playing') {
          room.gameState.timer--;
          if (room.gameState.timer <= 0) {
            if (room.gameState.score.blue === room.gameState.score.red && !room.gameState.isOvertime) {
              // Start Overtime
              room.gameState.isOvertime = true;
              room.gameState.timer = 60; // 1 minute overtime
              room.gameState.message = 'OVERTIME!';
            } else {
              room.gameState.matchState = 'gameover';
              if (room.gameState.score.blue > room.gameState.score.red) {
                room.gameState.message = 'BLUE WINS!';
              } else if (room.gameState.score.red > room.gameState.score.blue) {
                room.gameState.message = 'RED WINS!';
              } else {
                room.gameState.message = 'DRAW!';
              }
              room.stateTimer = 5;
            }
          }
        }
 else if (room.gameState.matchState === 'goal') {
          room.stateTimer--;
          if (room.stateTimer <= 0) {
            if (room.gameState.isOvertime) {
              room.gameState.matchState = 'gameover';
              room.stateTimer = 5;
            } else {
              room.resetPositions();
              room.gameState.matchState = 'playing';
              room.gameState.message = '';
              delete room.gameState.lastScorer;
            }
          }
        } else if (room.gameState.matchState === 'gameover') {
          room.stateTimer--;
          if (room.stateTimer <= 0) {
            io.to(room.id).emit('matchEnded');
            if (room.id !== 'FREEPLAY') {
              room.gameState.matchState = 'freeplay';
              room.gameState.message = `ROOM: ${room.id}\nWAITING FOR PLAYERS...`;
            } else {
              room.gameState.matchState = 'waiting';
              room.gameState.message = 'Waiting for players...';
            }
            room.gameState.score = { red: 0, blue: 0 };
            room.gameState.isOvertime = false;
            delete room.gameState.lastScorer;
            room.resetPositions();
          }
        }
      }

      if (room.gameState.matchState === 'playing' || room.gameState.matchState === 'freeplay') {
        const speed = 15;
        const acceleration = 100;
        for (const id in room.playerInputs) {
          const input = room.playerInputs[id];
          const body = room.playerBodies[id];
          if (body) {
            const targetVelX = input.x * speed;
            const targetVelZ = input.z * speed;
            
            const forceX = (targetVelX - body.velocity.x) * acceleration;
            const forceZ = (targetVelZ - body.velocity.z) * acceleration;
            
            body.applyForce(new CANNON.Vec3(forceX, 0, forceZ), body.position);
            
            if (input.jump) {
              if (body.position.y <= 1.1) {
                body.velocity.y = 8;
                const state = room.gameState.players[id];
                if (state) state.lastJumpTime = Date.now();
              }
              input.jump = false;
            }

            if (input.kick) {
              const distance = body.position.distanceTo(room.ballBody.position);
              if (distance < 2.2) {
                const angle = input.cameraAngle || 0;
                const dir = new CANNON.Vec3(-Math.sin(angle), 0.3, -Math.cos(angle));
                dir.normalize();
                
                const kickSpeed = 18;
                room.ballBody.velocity.set(dir.x * kickSpeed, dir.y * kickSpeed, dir.z * kickSpeed);
                
                const state = room.gameState.players[id];
                if (state) {
                  state.lastKickTime = Date.now();
                  state.kicks++;
                  
                  if (room.lastTouchId !== id) {
                    room.secondLastTouchId = room.lastTouchId;
                    room.lastTouchId = id;
                  }
                }
              }
              input.kick = false; 
            } else {
              const distance = body.position.distanceTo(room.ballBody.position);
              if (distance < 1.8 && (Math.abs(body.velocity.x) > 0.1 || Math.abs(body.velocity.z) > 0.1)) {
                const dribbleForce = new CANNON.Vec3(body.velocity.x, 0, body.velocity.z);
                dribbleForce.normalize();
                dribbleForce.y = -0.1;
                room.ballBody.applyForce(dribbleForce.scale(5), room.ballBody.position);

                if (room.lastTouchId !== id) {
                  room.secondLastTouchId = room.lastTouchId;
                  room.lastTouchId = id;
                }
              }
            }
          }
        }
      } else {
        for (const id in room.playerBodies) {
          room.playerBodies[id].velocity.set(0, 0, 0);
        }
      }

      room.world.step(TICK_DT);

      const maxBallSpeed = 25;
      const currentSpeed = room.ballBody.velocity.length();
      if (currentSpeed > maxBallSpeed) {
        room.ballBody.velocity.scale(maxBallSpeed / currentSpeed, room.ballBody.velocity);
      }

      if (room.gameState.matchState === 'playing' || room.gameState.matchState === 'freeplay') {
        const goalWidth = 8;
        const goalHeight = 3;
        const ballRadius = 0.5;
        
        const isInsideWidth = Math.abs(room.ballBody.position.x) < (goalWidth / 2);
        const isBelowHeight = room.ballBody.position.y < goalHeight;

        if (isInsideWidth && isBelowHeight) {
          if (room.ballBody.position.z > 40 / 2 + ballRadius) {
            if (room.gameState.matchState === 'playing') {
              room.gameState.score.blue++;
              
              if (room.gameState.isOvertime) {
                room.gameState.matchState = 'gameover';
                room.gameState.message = 'BLUE WINS!';
                room.stateTimer = 5;
              } else {
                room.gameState.matchState = 'goal';
                room.gameState.message = 'BLUE SCORES!';
                room.stateTimer = 3;
              }

              // Stats
              if (room.lastTouchId) {
                const scorer = room.gameState.players[room.lastTouchId];
                if (scorer) {
                  if (scorer.team === 'blue') {
                    scorer.goals++;
                  }
                  room.gameState.lastScorer = {
                    name: scorer.name,
                    team: scorer.team,
                    country: scorer.worldCupCountry
                  };
                  if (room.secondLastTouchId) {
                    const assistant = room.gameState.players[room.secondLastTouchId];
                    if (assistant && assistant.team === 'blue' && assistant.id !== scorer.id) {
                      assistant.assists++;
                    }
                  }
                }
              }
              room.lastTouchId = null;
              room.secondLastTouchId = null;

              io.to(room.id).emit("goal", { team: 'blue', score: room.gameState.score });
            } else {
              room.ballBody.position.set(0, 5, 0);
              room.ballBody.velocity.set(0, 0, 0);
              room.ballBody.angularVelocity.set(0, 0, 0);
            }
          } else if (room.ballBody.position.z < -40 / 2 - ballRadius) {
            if (room.gameState.matchState === 'playing') {
              room.gameState.score.red++;
              
              if (room.gameState.isOvertime) {
                room.gameState.matchState = 'gameover';
                room.gameState.message = 'RED WINS!';
                room.stateTimer = 5;
              } else {
                room.gameState.matchState = 'goal';
                room.gameState.message = 'RED SCORES!';
                room.stateTimer = 3;
              }

              // Stats
              if (room.lastTouchId) {
                const scorer = room.gameState.players[room.lastTouchId];
                if (scorer) {
                  if (scorer.team === 'red') {
                    scorer.goals++;
                  }
                  room.gameState.lastScorer = {
                    name: scorer.name,
                    team: scorer.team,
                    country: scorer.worldCupCountry
                  };
                  if (room.secondLastTouchId) {
                    const assistant = room.gameState.players[room.secondLastTouchId];
                    if (assistant && assistant.team === 'red' && assistant.id !== scorer.id) {
                      assistant.assists++;
                    }
                  }
                }
              }
              room.lastTouchId = null;
              room.secondLastTouchId = null;

              io.to(room.id).emit("goal", { team: 'red', score: room.gameState.score });
            } else {
              room.ballBody.position.set(0, 5, 0);
              room.ballBody.velocity.set(0, 0, 0);
              room.ballBody.angularVelocity.set(0, 0, 0);
            }
          }
        }
      }

      room.gameState.ball.position = [room.ballBody.position.x, room.ballBody.position.y, room.ballBody.position.z];
      room.gameState.ball.velocity = [room.ballBody.velocity.x, room.ballBody.velocity.y, room.ballBody.velocity.z];
      room.gameState.ball.rotation = [room.ballBody.quaternion.x, room.ballBody.quaternion.y, room.ballBody.quaternion.z, room.ballBody.quaternion.w];

      for (const id in room.playerBodies) {
        const body = room.playerBodies[id];
        const state = room.gameState.players[id];
        if (state) {
          state.position = [body.position.x, body.position.y, body.position.z];
          state.velocity = [body.velocity.x, body.velocity.y, body.velocity.z];
          
          if (Math.abs(body.velocity.x) > 0.1 || Math.abs(body.velocity.z) > 0.1) {
            const angle = Math.atan2(body.velocity.x, body.velocity.z);
            const quat = new CANNON.Quaternion();
            quat.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), angle);
            state.rotation = [quat.x, quat.y, quat.z, quat.w];
          }
        }
      }

      io.to(room.id).emit("update", room.gameState);
    }
  }, 1000 / TICK_RATE);

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running in ${process.env.NODE_ENV === "production" ? "production" : "development"} mode on port ${PORT}`);
  });
}

startServer();
