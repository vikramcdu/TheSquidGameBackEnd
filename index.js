// index.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const { Console } = require('console');

// Load environment variables
dotenv.config();

// Initialize app and server
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Middlewares
app.use(cors());
app.use(express.json());

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('MongoDB connected'))
.catch(err => console.error('MongoDB connection error:', err));

// Room model schema
const roomSchema = new mongoose.Schema({
  roomCode: String,
  host: String,
  players: [
    {
      socketId: String,
      username: String,
      position: Number,
      eliminated: Boolean,
      color: String
    }
  ],
  status: String,
  winner: String
});

const Room = mongoose.model('Room', roomSchema);

// In-memory room state
const rooms = {}; // { roomCode: { players: [], status, etc. } }

// Socket.IO events
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('create_room', async ({ username }, callback) => {
    const roomCode = Math.random().toString(36).substr(2, 6).toUpperCase();
    console.log(`Room created: ${roomCode}`);
    const color = '#' + Math.floor(Math.random()*16777215).toString(16);
    const newRoom = new Room({
      roomCode,
      host: socket.id,
      players: [{ socketId: socket.id, username, position: 0, eliminated: false, color }],
      status: 'waiting'
    });
    await newRoom.save();

    rooms[roomCode] = newRoom;
    socket.join(roomCode);
    callback({ success: true, roomCode });
    io.to(roomCode).emit('player_joined', newRoom.players);
  });

  socket.on('join_room', async ({ roomCode, username }, callback) => {
    const room = rooms[roomCode];
    if (!room || room.status !== 'waiting') {
      return callback({ success: false, message: 'Room not found or already started.' });
    }
    const color = '#' + Math.floor(Math.random()*16777215).toString(16);
    room.players.push({ socketId: socket.id, username, position: 0, eliminated: false, color });
    console.log(`Player ${username} joined room: ${roomCode}`);
    await Room.updateOne({ roomCode }, { players: room.players });
    socket.join(roomCode);
    callback({ success: true });
    io.to(roomCode).emit('player_joined', room.players);
  });

  socket.on('start_game', async (roomCode) => {
    if (rooms[roomCode]) {
      rooms[roomCode].status = 'active';
      await Room.updateOne({ roomCode }, { status: 'active' });
      io.to(roomCode).emit('game_started');
      console.log(`Game started in room: ${roomCode}`);
    }
  });

  socket.on('reconnect_player', async ({ roomCode, username }) => {
    const room = rooms[roomCode];
    if (!room) {
      console.log(`Reconnect failed: room ${roomCode} not found`);
      return;
    }
  
    const player = room.players.find(p => p.username === username);
    if (player) {
      console.log(`Reconnecting player ${username}. Old socket: ${player.socketId} → New socket: ${socket.id}`);
      player.socketId = socket.id; // update to new socket
      await Room.updateOne({ roomCode }, { players: room.players });
    } else {
      console.log(`Reconnect failed: player ${username} not found in room ${roomCode}`);
    }
  });  

  socket.on('update_position', async ({ roomCode, positionIncrement }) => {
    const room = rooms[roomCode];
    if (!room) return;
  
    const player = room.players.find(p => p.socketId === socket.id);
    if (player) {
      player.position = (player.position || 0) + positionIncrement;
      console.log(`[Player ${player.username} position updated to ${player.position}]`);
    }
  
    await Room.updateOne({ roomCode }, { players: room.players });
    io.to(roomCode).emit('position_update', room.players);
  });
  

  socket.on('player_eliminated', async (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (player) player.eliminated = true;
    await Room.updateOne({ roomCode }, { players: room.players });
    io.to(roomCode).emit('position_update', room.players);
  });

  socket.on('declare_winner', async ({ roomCode, username }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.winner = username;
    room.status = 'finished';
    await Room.updateOne({ roomCode }, { winner: username, status: 'finished' });
    io.to(roomCode).emit('game_winner', username);
  });

  socket.on('reset_game', async (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.status = 'waiting';
    room.winner = '';
    room.players.forEach(p => { p.position = 0; p.eliminated = false; });
    await Room.updateOne({ roomCode }, { players: room.players, winner: '', status: 'waiting' });
    io.to(roomCode).emit('game_reset', room.players);
  });

  socket.on('disconnect', async () => {
    console.log(`User disconnected: ${socket.id}`);
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const idx = room.players.findIndex(p => p.socketId === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        await Room.updateOne({ roomCode }, { players: room.players });
        io.to(roomCode).emit('player_left', socket.id);
      }
    }
  });

  socket.on('player_ready', async ({ roomCode, username }) => {
    const room = rooms[roomCode];
    if (!room) return;
  
    const player = room.players.find(p => p.username === username);
    if (player) {
      player.ready = true; // Set player as ready
  
      // Check if all players are ready
      const allReady = room.players.every(p => p.ready);
      if (allReady) {
        io.to(roomCode).emit('start_game_now'); // Tell all players to start game
        io.to(roomCode).emit('position_update', rooms[roomCode].players);
        console.log(`All players ready. Starting game in room ${roomCode}`);
      }
    }
  });
});


// Start server
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
