/**
 * @copyright 2026 hentertrabelsi
 * @contact Email: hentertrabelsi@gmail.com
 * @discord #susuxo
 * 
 * All rights reserved. This software is proprietary and confidential.
 * You may not use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software without explicit permission.
 */
import express from "express";
import { Server as SocketIOServer } from "socket.io";
import http from "http";
import path from "path";
import fs from "fs";
import * as CANNON from "cannon-es";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";

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
  waitingTicks?: number;
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
  world.addContactMaterial(new CANNON.ContactMaterial(wallMaterial, ballMaterial, { friction: 0.0, restitution: 0.1 }));
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

  // Corner Bumpers (Vertical Curve)
  const createCornerCurve = (x: number, z: number, radius: number) => {
    const cylinderShape = new CANNON.Cylinder(radius, radius, wallHeight, 16);
    const cornerBody = new CANNON.Body({
      type: CANNON.Body.STATIC,
      material: wallMaterial,
    });
    // CANNON cylinder is oriented along its local Z axis. Rotate to align with Y.
    const q = new CANNON.Quaternion();
    q.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    cornerBody.addShape(cylinderShape, new CANNON.Vec3(0, 0, 0), q);
    cornerBody.position.set(x, wallHeight / 2, z);
    world.addBody(cornerBody);
  };

  const cr = 4; // corner radius
  // Top Left (-x, -z)
  createCornerCurve(-fieldWidth / 2 + cr, -fieldLength / 2 + cr, cr);
  // Top Right (+x, -z)
  createCornerCurve(fieldWidth / 2 - cr, -fieldLength / 2 + cr, cr);
  // Bottom Left (-x, +z)
  createCornerCurve(-fieldWidth / 2 + cr, fieldLength / 2 - cr, cr);
  // Bottom Right (+x, +z)
  createCornerCurve(fieldWidth / 2 - cr, fieldLength / 2 - cr, cr);

  // Corner Banks / Ramps (Rocket League Style)
  const createCornerBank = (x: number, z: number, angleY: number) => {
    const bankShape = new CANNON.Box(new CANNON.Vec3(10, 0.5, 4));
    const bankBody = new CANNON.Body({
      type: CANNON.Body.STATIC,
      material: wallMaterial,
    });
    
    // Pitch up by 45 degrees
    const qPitch = new CANNON.Quaternion();
    qPitch.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 4);
    
    // Yaw to face the center
    const qYaw = new CANNON.Quaternion();
    qYaw.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), angleY);
    
    bankBody.quaternion = qYaw.mult(qPitch);
    bankBody.position.set(x, 1, z);
    world.addBody(bankBody);
  };

  // Add 45-degree sloping banks in the 4 corners so the ball rolls upwards
  createCornerBank(-fieldWidth / 2 + cr/2, -fieldLength / 2 + cr/2, Math.PI / 4);     // Top Left
  createCornerBank(fieldWidth / 2 - cr/2, -fieldLength / 2 + cr/2, -Math.PI / 4);     // Top Right
  createCornerBank(-fieldWidth / 2 + cr/2, fieldLength / 2 - cr/2, 3 * Math.PI / 4);  // Bottom Left
  createCornerBank(fieldWidth / 2 - cr/2, fieldLength / 2 - cr/2, -3 * Math.PI / 4);  // Bottom Right

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
    waitingTicks: 0,
  };
}

// Helper to generate random room code
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

const BOT_NAMES = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Charlie', 'Avery', 'Parker', 'Quinn', 'Peyton', 'Skyler', 'Dakota', 'Reese', 'Rowan', 'Hayden', 'Emerson', 'Finley', 'Mia', 'Liam', 'Noah', 'Emma', 'Oliver', 'Ava', 'Elijah'];

function addBot(room: Room, team: 'red' | 'blue', isHumanLike: boolean = false) {
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
  
  const botName = isHumanLike ? BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] : `AI (${room.difficulty.toUpperCase()})`;

  room.gameState.players[botId] = {
    id: botId,
    name: botName,
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
  if (room.botIds.length === 0) return;

  const ballPos = room.ballBody.position;

  if (room.isTraining) {
    const reactionDelay = room.difficulty === 'easy' ? 30 : room.difficulty === 'medium' ? 15 : 5;
    for (const botId of room.botIds) {
      const botBody = room.playerBodies[botId];
      const botState = room.gameState.players[botId];
      if (!botBody || !botState) continue;

      if (room.ticks % reactionDelay !== 0) continue;

      const input = room.playerInputs[botId];
      const opponentGoalZ = botState.team === 'red' ? -20 : 20;

      const toBallX = ballPos.x - botBody.position.x;
      const toBallZ = ballPos.z - botBody.position.z;
      const distToBall = Math.sqrt(toBallX * toBallX + toBallZ * toBallZ);

      let targetX = ballPos.x;
      let targetZ = ballPos.z;

      const isBallBehind = botState.team === 'red' ? (ballPos.z > botBody.position.z + 1) : (ballPos.z < botBody.position.z - 1);

      if (isBallBehind) {
        targetZ = ballPos.z + (botState.team === 'red' ? 3 : -3);
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

      if (distToBall < 2.5) {
        const toGoalX = 0 - botBody.position.x;
        const toGoalZ = opponentGoalZ - botBody.position.z;
        const dot = (toBallX * toGoalX + toBallZ * toGoalZ);
        
        if (dot > 0 || room.difficulty === 'hard') {
          input.kick = true;
          input.cameraAngle = Math.atan2(-toGoalX, -toGoalZ);
        }
      }

      if (room.difficulty === 'hard' && Math.random() < 0.01 && botBody.position.y < 1.1) {
        input.jump = true;
      }
    }
    return;
  }

  // Make bots generally slower to react in standard non-training matches 
  // (30 ticks = 0.5s delay, 45 ticks = 0.75s delay)
  const reactionDelay = 45;

  // Group bots by team
  const botsByTeam: Record<string, string[]> = { red: [], blue: [] };
  for (const botId of room.botIds) {
    const state = room.gameState.players[botId];
    if (state) {
      botsByTeam[state.team].push(botId);
    }
  }

  for (const team of ['red', 'blue']) {
    const teamBots = botsByTeam[team];
    if (teamBots.length === 0) continue;

    // Determine roles based on distance to ball
    let closestBotId = teamBots[0];
    let minBotDist = Infinity;
    
    for (const botId of teamBots) {
      const botBody = room.playerBodies[botId];
      if (!botBody) continue;
      const dist = Math.sqrt(
        Math.pow(botBody.position.x - ballPos.x, 2) + 
        Math.pow(botBody.position.z - ballPos.z, 2)
      );
      if (dist < minBotDist) {
        minBotDist = dist;
        closestBotId = botId;
      }
    }

    for (const botId of teamBots) {
      const botBody = room.playerBodies[botId];
      const botState = room.gameState.players[botId];
      if (!botBody || !botState) continue;

      // Stagger updates so bots don't all react on exactly the same tick
      const offset = room.botIds.indexOf(botId);
      if ((room.ticks + offset) % reactionDelay !== 0) continue;

      const input = room.playerInputs[botId];
      const opponentGoalZ = botState.team === 'red' ? -20 : 20;
      const ourGoalZ = botState.team === 'red' ? 20 : -20;

      const toBallX = ballPos.x - botBody.position.x;
      const toBallZ = ballPos.z - botBody.position.z;
      const distToBall = Math.sqrt(toBallX * toBallX + toBallZ * toBallZ);

      let targetX = ballPos.x;
      let targetZ = ballPos.z;

      const role = (botId === closestBotId) ? 'chaser' : 'defender';

      if (role === 'chaser') {
        // Chaser Logic
        const isBallBehind = botState.team === 'red' ? (ballPos.z > botBody.position.z + 1) : (ballPos.z < botBody.position.z - 1);

        if (isBallBehind) {
          // Move to a position behind the ball first
          targetZ = ballPos.z + (botState.team === 'red' ? 4 : -4);
          // Add some horizontal offset to avoid running into the ball while repositioning
          if (Math.abs(toBallX) < 2) {
            targetX = ballPos.x + (toBallX > 0 ? -4 : 4);
          }
        }
        
        // In standard non-training matches, make chaser movement slightly inaccurate
        if (!room.isTraining) {
            targetX += (Math.random() - 0.5) * 3;
            targetZ += (Math.random() - 0.5) * 3;
        }
      } else {
        // Defender Logic
        // Stay between the ball and our goal, staying back
        targetZ = ourGoalZ + (botState.team === 'red' ? -6 : 6);
        targetX = ballPos.x * 0.4; // Follow the X position loosely
        targetX = Math.max(-4, Math.min(4, targetX)); // Stay within goal posts
      }

      const dirX = targetX - botBody.position.x;
      const dirZ = targetZ - botBody.position.z;
      const dist = Math.sqrt(dirX * dirX + dirZ * dirZ);

      if (dist > 0.5) {
        input.x = dirX / dist;
        input.z = dirZ / dist;
        
        // Very Easy logic: sluggish speed for general play
        if (!room.isTraining) {
          // Occasional hesitation
          if (Math.random() < 0.3) {
             input.x *= 0.3;
             input.z *= 0.3;
          }
        }
      } else {
        input.x = 0;
        input.z = 0;
      }

      // Kicking logic
      if (distToBall < 3.0) {
        const toGoalX = 0 - botBody.position.x;
        const toGoalZ = opponentGoalZ - botBody.position.z;
        const dot = (toBallX * toGoalX + toBallZ * toGoalZ);
        
        if (role === 'defender') {
          // Defenders just clear the ball if it comes near them
          input.kick = true;
          input.cameraAngle = Math.atan2(-toGoalX, -toGoalZ);
        } else {
          // Chasers kick if headed roughly towards goal
          if (dot > 0 || room.difficulty === 'hard') {
            input.kick = true;
            input.cameraAngle = Math.atan2(-toGoalX, -toGoalZ);
          }
        }
      }

      // Random jumps for Hard difficulty
      if (room.difficulty === 'hard' && Math.random() < 0.01 && botBody.position.y < 1.1) {
        input.jump = true;
      }
    }
  }
}

async function startServer() {
  const app = express();

  // Security Middlewares
  app.set("trust proxy", 1); // Trust first proxy (Render/Vercel)
  app.use(helmet());

  const allowedOrigins = process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(",") 
    : ["http://localhost:5173", "http://localhost:3000"];
    
  app.use(cors({
    origin: allowedOrigins,
    methods: ["GET", "POST"]
  }));

  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 100, // Limit each IP to 100 requests per 15 minutes
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  });
  
  app.use('/api/', apiLimiter);

  const server = http.createServer(app);
  const io = new SocketIOServer(server, { 
    cors: { 
      origin: allowedOrigins,
      methods: ["GET", "POST"]
    } 
  });

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
    if (room.botIds.length > 0) {
      const maxPlayers = room.isWorldCup ? 2 : 4;
      const currentTotal = Object.keys(room.gameState.players).length;
      if (currentTotal >= maxPlayers) {
        const botIdToRemove = room.botIds[0];
        
        if (room.playerBodies[botIdToRemove]) {
          room.world.removeBody(room.playerBodies[botIdToRemove]);
          delete room.playerBodies[botIdToRemove];
        }
        delete room.playerInputs[botIdToRemove];
        delete room.gameState.players[botIdToRemove];
        room.botIds = room.botIds.filter(id => id !== botIdToRemove);
        
        io.to(room.id).emit("playerLeft", botIdToRemove);
      }
    }

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

  const chatRateLimits = new Map<string, number[]>();

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("joinQueue", ({ name, worldCupCountry, isWorldCup }: { name: string, worldCupCountry?: string, isWorldCup?: boolean }) => {
      leaveRoom(socket);
      
      const queue = isWorldCup ? worldCupQueue : matchmakingQueue;
      
      // 1. Try to find an existing public match with space
      let targetRoom: Room | null = null;
      for (const room of rooms.values()) {
        if (room.id !== 'FREEPLAY' && room.id !== 'WORLD_CUP_FREEPLAY' && !room.isPrivate && room.isWorldCup === !!isWorldCup) {
          const humanCount = Object.keys(room.gameState.players).filter(id => !room.botIds.includes(id)).length;
          const maxPlayers = isWorldCup ? 2 : 4;
          if (humanCount < maxPlayers && room.gameState.matchState !== 'gameover') {
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
      
      const now = Date.now();
      const timestamps = chatRateLimits.get(socket.id) || [];
      const recentTimestamps = timestamps.filter(t => now - t < 10000); // within last 10 seconds
      
      if (recentTimestamps.length >= 5) {
        socket.emit("error", "Chat rate limit exceeded. Please wait.");
        return;
      }
      
      recentTimestamps.push(now);
      chatRateLimits.set(socket.id, recentTimestamps);

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
      chatRateLimits.delete(socket.id);
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
              const humanCount = Object.keys(room.gameState.players).filter(id => !room.botIds.includes(id)).length;
              const maxPlayers = isWorldCup ? 2 : 4;
              if (humanCount < maxPlayers && room.gameState.matchState !== 'gameover') {
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
      if (queue.length >= 1) {
        const maxPlayers = isWorldCup ? 2 : 4;
        const playersToMove = [];
        while (queue.length > 0 && playersToMove.length < maxPlayers) {
          playersToMove.push(queue.shift()!);
        }
        
        const matchRoomId = generateRoomCode();
        const matchRoom = createRoom(matchRoomId, false, false, 'medium', isWorldCup);
        rooms.set(matchRoomId, matchRoom);

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
      
      if (room.botIds.length > 0) {
        updateBots(room);
      }

      if (room.ticks >= TICK_RATE) {
        room.ticks = 0;
        
        if (room.gameState.matchState === 'waiting' || (room.gameState.matchState === 'freeplay' && room.id !== 'FREEPLAY' && room.id !== 'WORLD_CUP_FREEPLAY')) {
          const maxPlayers = room.isWorldCup ? 2 : 4;
          const currentTotal = Object.keys(room.gameState.players).length;
          const humanCount = Object.keys(room.gameState.players).filter(id => !room.botIds.includes(id)).length;

          const readyToStart = room.isPrivate ? (currentTotal >= 2) : (currentTotal >= maxPlayers);

          if (readyToStart) {
            room.gameState.matchState = 'countdown';
            room.gameState.timer = 5;
            room.gameState.message = '';
            room.gameState.score = { red: 0, blue: 0 };
            room.gameState.isOvertime = false;
            room.waitingTicks = 0;
            delete room.gameState.lastScorer;
            room.resetPositions();
          } else if (!room.isPrivate && humanCount > 0 && humanCount < maxPlayers) {
            room.waitingTicks = (room.waitingTicks || 0) + TICK_RATE;
            
            if (room.waitingTicks >= 10 * TICK_RATE) {
              while (Object.keys(room.gameState.players).length < maxPlayers) {
                const teamCount = Object.values(room.gameState.players).reduce(
                  (acc, p) => { acc[p.team]++; return acc; },
                  { red: 0, blue: 0 }
                );
                const team = teamCount.red <= teamCount.blue ? 'red' : 'blue';
                addBot(room, team, true);
              }
              room.gameState.matchState = 'countdown';
              room.gameState.timer = 5;
              room.gameState.message = '';
              room.gameState.score = { red: 0, blue: 0 };
              room.gameState.isOvertime = false;
              room.waitingTicks = 0;
              delete room.gameState.lastScorer;
              room.resetPositions();
            } else {
              room.gameState.message = `Waiting for players...`;
            }
          } else {
            room.waitingTicks = 0;
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
    const { createServer } = await import("vite");
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    const indexPath = path.join(distPath, "index.html");
    
    if (fs.existsSync(indexPath)) {
      app.use(express.static(distPath));
      app.get("*", (req, res) => {
        res.sendFile(indexPath);
      });
    } else {
      app.get("/", (req, res) => {
        res.json({ 
          message: "Soccer Rivals 3D Backend is running.", 
          status: "healthy",
          serverTime: new Date().toISOString()
        });
      });
    }
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running in ${process.env.NODE_ENV === "production" ? "production" : "development"} mode on port ${PORT}`);
  });
}

startServer();


/**
 * @copyright 2026 hentertrabelsi - All Rights Reserved
 */
