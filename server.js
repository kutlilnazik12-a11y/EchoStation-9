/**
 * ЭХО СТАНЦИИ: ОБЪЕКТ-9 — Компактный авторитетный сервер (1 файл, 0 внешних зависимостей).
 * Одновременно раздаёт index.html и обслуживает реальный WebSocket-мультиплеер.
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


// === SHARED: protocol.js ===
/**
 * Общий сетевой протокол клиента и сервера «ЭХО СТАНЦИИ: ОБЪЕКТ-9».
 */

const PROTOCOL_VERSION = '1.1.0';

const LIMITS = {
  MAX_PLAYERS_DEFAULT: 4,
  MAX_PLAYERS_CAP: 6,
  MIN_PLAYERS_ONLINE: 1,
  MAX_NAME_LENGTH: 18,
  MAX_ROOM_NAME_LENGTH: 28,
  MAX_CHAT_LENGTH: 160,
  MAX_MOVE_SPEED: 6.2,
  INTERACT_RANGE: 3.3,
  PLAYER_INTERACT_RANGE: 3.6,
  RECONNECT_GRACE_MS: 45_000,
  SERVER_TICK_HZ: 15,
  CLIENT_SEND_HZ: 15,
};

const MSG = {
  // Клиент -> Сервер (C2S)
  HELLO: 'c2s:hello',
  PING: 'c2s:ping',
  LIST_ROOMS: 'c2s:list_rooms',
  CREATE_ROOM: 'c2s:create_room',
  JOIN_ROOM: 'c2s:join_room',
  JOIN_BY_CODE: 'c2s:join_by_code',
  RECONNECT: 'c2s:reconnect',
  LEAVE_ROOM: 'c2s:leave_room',
  SET_READY: 'c2s:set_ready',
  UPDATE_PROFILE: 'c2s:update_profile',
  START_GAME: 'c2s:start_game',
  RETURN_LOBBY: 'c2s:return_lobby',
  PLAYER_STATE: 'c2s:player_state',
  INTERACT_OBJECT: 'c2s:interact_object',
  INTERACT_PLAYER: 'c2s:interact_player',
  SUBMIT_CODE: 'c2s:submit_code',
  CHAT_SEND: 'c2s:chat_send',
  RADIO_PING: 'c2s:radio_ping',

  // Сервер -> Клиент (S2C)
  WELCOME: 's2c:welcome',
  PONG: 's2c:pong',
  ERROR: 's2c:error',
  ROOM_LIST: 's2c:room_list',
  ROOM_JOINED: 's2c:room_joined',
  ROOM_LEFT: 's2c:room_left',
  LOBBY_STATE: 's2c:lobby_state',
  GAME_STARTED: 's2c:game_started',
  WORLD_SNAPSHOT: 's2c:world_snapshot',
  OBJECT_UPDATED: 's2c:object_updated',
  OPEN_KEYPAD: 's2c:open_keypad',
  PLAYER_ACTION: 's2c:player_action',
  CHAT_MESSAGE: 's2c:chat_message',
  RADIO_SIGNAL: 's2c:radio_signal',
  HORROR_EVENT: 's2c:horror_event',
  SESSION_ENDED: 's2c:session_ended',
  SYSTEM_NOTICE: 's2c:system_notice',
};

const ROOM_STATUS = {
  LOBBY: 'lobby',
  PLAYING: 'playing',
  ENDED: 'ended',
};

const EVENT_SCOPE = {
  GLOBAL: 'global',
  INDIVIDUAL: 'individual',
  DYNAMIC: 'dynamic',
};

// === SHARED: mapData.js ===
const CURRENT_FLOOR = { id: 1, code: 'B1', name: 'Сектор-9 · Этаж 1', medbayBed: { x: 39.6, z: 0.0, yaw: Math.PI / 2 } };

/**
 * Авторитетная КЛЕТОЧНАЯ карта «ОБЪЕКТ-9» (v5.0 — Tile-Grid Map Compiler).
 * Сетка 3.6 × 3.6 м:
 * - Каждая стена — ровно целая клетка (объединяется в чистые прямоугольники без швов и Z-fighting).
 * - Все коридоры — настоящие 3.6м проходы с поворотами и ответвлениями (без «комнат с колоннами»).
 * - Каждый шкафчик, декор, табличка, генератор, стол и ключ-карта занимают УНИКАЛЬНУЮ свободную клетку
 *   и автоматически привязываются вплотную к соседней стене лицом в проход.
 * - Физически исключены наложения предметов друг на друга, вылеты в стены и софтлоки!
 */

const CELL_SIZE = 3.6;

const MAP_CONFIG = {
  name: 'Подземная станция «Объект-9»',
  ceilingHeight: 3.6,
  worldBounds: { minX: -52, maxX: 52, minZ: -44, maxZ: 56 },
  playerRadius: 0.42,
  requiredRelays: 7,
};

// Единая 2D-схема станции (25 столбцов × 25 строк, 1 клетка = 3.6 × 3.6 м)
// Центр хаба: col=12, row=10 -> world (0, 0)
// Легенда:
//   # = стена (3.6м)     . = коридор / пол     S = открытый архивный стеллаж
//   T = терминал шлюза   A = шлюз «Альфа»      1 = открытая гермодверь (Запад/Восток/Медотсек)
//   C = дверь Столовой   K = дверь Склада      P = дверь Насосной
//   b = барьер под присед (на всю ширину коридора)
//   L = шкафчик (автопривязка к соседней стене)
const GRID_ROWS = [
  '#########.......#########', // row 0  (Шлюз Альфа)
  '#########...T...#########', // row 1
  '#########.#####.#########', // row 2  <- замкнутый периметр шлюза
  '#########...A...#########', // row 3  <- Шлюз Альфа (нужны 7 генераторов)
  '###########...###########', // row 4  (Северный коридор + СВ тоннель)
  '###########.L.#####.....#', // row 5  (СВ техтоннель)
  '###########...#...b.....#', // row 6  (СВ техтоннель с приседом)
  '#####.....#.###.###.###.#', // row 7  (Верхние коридоры Запада и Востока)
  '#...#.###.#.#...#.#.#...#', // row 8  (Столовая | Запад | Центр | Восток | Медотсек)
  '#...#.L.#...#.###.#...#.#', // row 9
  '#...C...1...1.....1...#.#', // row 10 (Центральная ось: Столовая-C-Запад-1-Хаб-1-Восток)
  '#...#.###.#.#.....#.#.#.#', // row 11
  '###.#.#...#.##...##.#.#1#', // row 12 (Дверь в Медотсек на col=23? Сделаем ровно!)
  '#...#.#.###.###K###.#...#', // row 13 (Кухня | Запад | Дверь Склада K | Восток | Медотсек)
  '#...#.#...#.#.....#.###.#', // row 14
  '#####.###.#.#.S.S.#.#...#', // row 15 (ЮЗ тоннель | Южный архив | Медотсек)
  '#####.#...#.#.....#.#...#', // row 16
  '#####.#.###.#.S.S.#.#####', // row 17
  '#####.#.L.#.b.....#.#####', // row 18 (Присед в ЮЗ-архивном обходе!)
  '#####.#...K...S.S.#.#####', // row 19 (Вторая дверь Склада K из ЮЗ тоннеля!)
  '#####.#####.#.....#.#####', // row 20
  '###########.###P###.#####', // row 21 (Дверь Насосной P)
  '###########.#.....#.#####', // row 22 (Насосная)
  '###########.L.b...#.#####', // row 23 (Насосная с приседом)
  '###########.#######.#####', // row 24
];

// Пересоберём сетку максимально чисто (27×25) так, чтобы каждый сектор был герметичен,
// коридоры были извилистыми (шириной 1 клетка = 3.6м), и все 11 секторов читались идеально!
const CLEAN_GRID = [
  '##########.......##########', // 00: Шлюз Альфа (внешняя стена сверху добавится автоматически)
  '##########...T...##########', // 01: Терминал эвакуации
  '##########.......##########', // 02: Камера шлюза
  '############.A.############', // 03: Гермодверь шлюза (7 генераторов)
  '############...############', // 04: Северный коридор
  '############.L.####.......#', // 05: СВ техтоннель (верх)
  '############...#....b.....#', // 06: СВ техтоннель (присед b)
  '#####......#...####.###.###', // 07: Северные ветки Запада и Востока
  '#...#.#.##.#.#####..#...#.#', // 08: Столовая (col 1..3) | Зап. лаб (col 5..11) | Ген. блок (col 15..20) | Медотсек (col 22..25)
  '#...#.#.L#.#.#...#..#.L.#.#', // 09:
  '#...#.#..#...#...#..#...#.#', // 10: Центральный узел (col 12..14, row 9..11) -> перенесём ровно!
  '###########################',
];
// Используем финальную выверенную 27×25 матрицу (с внешним кольцом # по краям):
const STATION_GRID = [
  '###########################', // 00
  '##########.......##########', // 01: Шлюз «Альфа»
  '##########...T...##########', // 02
  '######...####A#############', // 03: Серверная (6..8, row 3..5 — уютная 3x3)
  '######...####.#############', // 04: Серверная
  '######...####.#############', // 05: Серверная
  '#######M#####...b.....#####', // 06: Дверь в Серверную M=(7,6) (мини-игра!) | СВ тоннель (b на 16,6)
  '#####.....###.#######.#####', // 07: Запад | Сев. кор | СВ->Восток
  '#...#.#...#.....#.....1...#', // 08: Столовая | Запад | Хаб | Восток | Медотсек 1=(22,8)
  '#...#.#.###.....#.###.#...#', // 09
  '#...#.....1.....1.....#.#.#', // 10: 1=Запад(10,10) | Хаб | 1=Восток(16,10) | Медотсек
  '#...#.#.###.....###.#.#...#', // 11
  '#...C.#.#####K#####.#.#.#.#', // 12: C=Столовая(4,12) | K=Склад(13,12)
  '###.#.#.#.........#.#.#...#', // 13: Кухня | ЮЗ тоннель | Склад (9..17) | Восток
  '#...#.#.#.SS.S.SS.#...#####', // 14: Склад с объединёнными стеллажами
  '#...#...#.........#...#####', // 15
  '#...#.###.SS.S.SS.##M######', // 16: Дверь в Комнату охраны M=(20,16) (мини-игра!)
  '#####.#.K.........#.....###', // 17: K=Техшлюз склада(8,17) | Комната охраны (19..23, row 17..18)
  '#####.#.#..SSSSS..#.....###', // 18: Комната охраны (обычная комната)
  '#####...#.........#########', // 19: ЮЗ тоннель замыкается в петлю
  '#############P#############', // 20: P=Насосная(13,20)
  '#########.........#########', // 21: Насосная
  '#########.###.###.#########', // 22
  '#########...b.....#########', // 23: Присед b=(12,23)
  '###########################', // 24
];

const ROWS = STATION_GRID.length;
const COLS = STATION_GRID[0].length;
const ORIGIN_COL = 13;
const ORIGIN_ROW = 10;

function gridToWorld(col, row) {
  return {
    x: Number(((col - ORIGIN_COL) * CELL_SIZE).toFixed(2)),
    z: Number(((row - ORIGIN_ROW) * CELL_SIZE).toFixed(2)),
  };
}

function getCell(col, row) {
  if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return '#';
  return STATION_GRID[row][col];
}

function isSolidCell(col, row) {
  const ch = getCell(col, row);
  return ch === '#' || ch === 'S';
}

function ensureOpenCell(col, row) {
  if (getCell(col, row) === '.') return { col, row };
  for (let rad = 1; rad <= 3; rad++) {
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        if (getCell(col + dc, row + dr) === '.') return { col: col + dc, row: row + dr };
      }
    }
  }
  return { col, row };
}

// Автоматически определяем стену, к которой можно прижать объект в клетке (col, row),
// и угол rotY, чтобы объект смотрел ЛИЦОМ в открытый коридор!
function snapToBackingWall(col, row, preferredSide = null, insetFromWall = 0.55) {
  const center = gridToWorld(col, row);
  const sides = [
    { name: 'N', dc: 0, dr: -1, rotY: 0, dx: 0, dz: -(CELL_SIZE / 2 - insetFromWall) },
    { name: 'S', dc: 0, dr: 1, rotY: Math.PI, dx: 0, dz: CELL_SIZE / 2 - insetFromWall },
    { name: 'W', dc: -1, dr: 0, rotY: Math.PI / 2, dx: -(CELL_SIZE / 2 - insetFromWall), dz: 0 },
    { name: 'E', dc: 1, dr: 0, rotY: -Math.PI / 2, dx: CELL_SIZE / 2 - insetFromWall, dz: 0 },
  ];
  const valid = sides.filter((s) => getCell(col + s.dc, row + s.dr) === '#');
  const pick = (preferredSide && valid.find((s) => s.name === preferredSide)) || valid[0] || sides[0];
  return {
    x: Number((center.x + pick.dx).toFixed(2)),
    z: Number((center.z + pick.dz).toFixed(2)),
    rotY: pick.rotY,
    side: pick.name,
  };
}

// 1. Компиляция стен (жадное слияние соседних клеток '#' в цельные прямоугольники — 0 швов, 0 Z-fighting!)
function compileWalls() {
  const walls = [];
  const used = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
  let wid = 0;

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (STATION_GRID[r][c] === 'S' && !used[r][c]) {
        // Объединяем соседние клетки 'S' в длинные сплошные архивные стеллажи по горизонтали или вертикали!
        let sw = 1;
        while (c + sw < COLS && STATION_GRID[r][c + sw] === 'S' && !used[r][c + sw]) sw++;
        let sh = 1;
        if (sw === 1) {
          while (r + sh < ROWS && STATION_GRID[r + sh][c] === 'S' && !used[r + sh][c]) sh++;
        }
        for (let rr = r; rr < r + sh; rr++) {
          for (let cc = c; cc < c + sw; cc++) used[rr][cc] = true;
        }
        const sp1 = gridToWorld(c, r);
        const sp2 = gridToWorld(c + sw - 1, r + sh - 1);
        walls.push({
          id: `arch_rack_${wid++}`,
          x: Number(((sp1.x + sp2.x) / 2).toFixed(2)),
          z: Number(((sp1.z + sp2.z) / 2).toFixed(2)),
          w: sw > 1 ? Number((sw * CELL_SIZE - 0.5).toFixed(2)) : 1.5,
          d: sh > 1 ? Number((sh * CELL_SIZE - 0.5).toFixed(2)) : 1.5,
        });
        continue;
      }
      if (STATION_GRID[r][c] !== '#' || used[r][c]) continue;
      // Расширяем максимально по ширине, затем по высоте
      let maxW = 1;
      while (c + maxW < COLS && STATION_GRID[r][c + maxW] === '#' && !used[r][c + maxW]) maxW++;
      let maxH = 1;
      outer: while (r + maxH < ROWS) {
        for (let k = 0; k < maxW; k++) {
          if (STATION_GRID[r + maxH][c + k] !== '#' || used[r + maxH][c + k]) break outer;
        }
        maxH++;
      }
      for (let rr = r; rr < r + maxH; rr++) {
        for (let cc = c; cc < c + maxW; cc++) used[rr][cc] = true;
      }
      const p1 = gridToWorld(c, r);
      const p2 = gridToWorld(c + maxW - 1, r + maxH - 1);
      walls.push({
        id: `w_${wid++}`,
        x: Number(((p1.x + p2.x) / 2).toFixed(2)),
        z: Number(((p1.z + p2.z) / 2).toFixed(2)),
        w: Number((maxW * CELL_SIZE).toFixed(2)),
        d: Number((maxH * CELL_SIZE).toFixed(2)),
      });
    }
  }
  return walls;
}

const WALLS = compileWalls();

// 2. Автоматическая компиляция барьеров под присед (все клетки 'b') — строго от стены до стены!
const CROUCH_BARRIERS = [];
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    if (STATION_GRID[r][c] === 'b') {
      const pos = gridToWorld(c, r);
      const wallN = getCell(c, r - 1) === '#';
      const wallS = getCell(c, r + 1) === '#';
      const horiz = wallN && wallS; // коридор идёт слева-направо -> балка поперёк (по Z)
      CROUCH_BARRIERS.push({
        id: `crouch_${c}_${r}`,
        x: pos.x,
        z: pos.z,
        w: horiz ? 0.95 : CELL_SIZE,
        d: horiz ? CELL_SIZE : 0.95,
      });
    }
  }
}

// Зоны для навигации и спавна (в мировых координатах, привязанных к клеткам)
const ZONES = [
  { id: 'hub', name: 'Центральный узел', minX: -9, maxX: 9, minZ: -5.4, maxZ: 9 },
  { id: 'north_corridor', name: 'Северный коридор', minX: -2.2, maxX: 2.2, minZ: -24, maxZ: -5.4 },
  { id: 'airlock', name: 'Шлюз «Альфа»', minX: -13, maxX: 13, minZ: -38, maxZ: -24 },
  { id: 'ne_tunnel', name: 'СВ техтоннель', minX: 2.2, maxX: 36, minZ: -17, maxZ: -9 },
  { id: 'west_wing', name: 'Западная лаборатория', minX: -31, maxX: -9, minZ: -14, maxZ: 19 },
  { id: 'canteen', name: 'Столовая и кухня', minX: -46, maxX: -31, minZ: -11, maxZ: 22 },
  { id: 'east_wing', name: 'Генераторный блок', minX: 9, maxX: 31, minZ: -11, maxZ: 19 },
  { id: 'medbay', name: 'Медотсек', minX: 31, maxX: 46, minZ: -4, maxZ: 19 },
  { id: 'sw_tunnel', name: 'ЮЗ техтоннель', minX: -31, maxX: -12, minZ: 19, maxZ: 34 },
  { id: 'south_archive', name: 'Южный архив', minX: -12, maxX: 24, minZ: 11, maxZ: 38 },
  { id: 'pump_room', name: 'Насосная', minX: -18, maxX: 18, minZ: 40, maxZ: 54 },
];

const SPAWN_POINTS = [
  { x: -1.8, z: 0.0, yaw: 0.0 },
  { x: 1.8, z: 0.0, yaw: 0.0 },
  { x: -1.8, z: 2.0, yaw: 0.0 },
  { x: 1.8, z: 2.0, yaw: 0.0 },
  { x: 0.0, z: 2.2, yaw: 0.0 },
  { x: 0.0, z: -1.6, yaw: 0.0 },
];

// 3. Настенные таблички — привязаны к клеткам и автоматически ложатся на реальную стену '#' (0.03м от грани)!
const SIGN_SPECS = [
  { col: 12, row: 9, side: 'N', text: 'ЦЕНТРАЛЬНЫЙ УЗЕЛ', sub: 'СЕКТОР-00', color: '#cbd5e1' },
  { col: 13, row: 1, side: 'N', text: 'ШЛЮЗ «АЛЬФА»', sub: 'ЭВАКУАЦИЯ', color: '#4ade80' },
  { col: 13, row: 5, side: 'W', text: 'СЕВЕРНЫЙ КОРИДОР', sub: 'К ШЛЮЗУ', color: '#4ade80' },
  { col: 16, row: 6, side: 'N', text: 'СВ ТЕХТОННЕЛЬ', sub: 'ОБХОДНОЙ КАНАЛ', color: '#94a3b8' },
  { col: 8, row: 10, side: 'N', text: 'ЗАПАДНАЯ ЛАБОРАТОРИЯ', sub: 'СЕКТОР-02', color: '#38bdf8' },
  { col: 7, row: 7, side: 'N', text: 'ЗАПАДНАЯ ЛАБОРАТОРИЯ', sub: 'СЕКТОР-02', color: '#38bdf8' },
  { col: 2, row: 8, side: 'N', text: 'СТОЛОВАЯ', sub: 'СЕКТОР-05', color: '#fbbf24' },
  { col: 2, row: 15, side: 'S', text: 'КУХНЯ', sub: 'ПИЩЕБЛОК', color: '#fbbf24' },
  { col: 18, row: 10, side: 'N', text: 'ГЕНЕРАТОРНЫЙ БЛОК', sub: 'СЕКТОР-03', color: '#f59e0b' },
  { col: 20, row: 8, side: 'N', text: 'ГЕНЕРАТОРНЫЙ БЛОК', sub: 'СЕКТОР-03', color: '#f59e0b' },
  { col: 24, row: 10, side: 'N', text: 'МЕДОТСЕК', sub: 'ЛАЗАРЕТ // СЕКТОР-06', color: '#34d399' },
  { col: 24, row: 14, side: 'S', text: 'МЕДОТСЕК', sub: 'ИЗОЛЯТОР', color: '#34d399' },
  { col: 13, row: 16, side: 'W', text: 'ЮЖНЫЙ АРХИВ', sub: 'СКЛАД // СЕКТОР-04', color: '#f87171' },
  { col: 8, row: 16, side: 'N', text: 'ЮЗ ТЕХТОННЕЛЬ', sub: 'К СКЛАДУ', color: '#fb923c' },
  { col: 13, row: 23, side: 'S', text: 'НАСОСНАЯ', sub: 'СЕКТОР-07', color: '#60a5fa' },
  { col: 7, row: 3, side: 'N', text: 'СЕРВЕРНАЯ', sub: 'УЗЕЛ ДАННЫХ', color: '#38bdf8' },
  { col: 21, row: 17, side: 'N', text: 'КОМНАТА ОХРАНЫ', sub: 'ПОСТ-03', color: '#f59e0b' },
];

function ensureWallBackedCell(col, row, preferredSide) {
  const hasWall = (c, r) =>
    getCell(c, r) === '.' &&
    [getCell(c, r - 1), getCell(c, r + 1), getCell(c - 1, r), getCell(c + 1, r)].includes('#');
  if (hasWall(col, row)) return { col, row };
  for (let rad = 1; rad <= 3; rad++) {
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        if (hasWall(col + dc, row + dr)) return { col: col + dc, row: row + dr };
      }
    }
  }
  return { col, row };
}

const WALL_SIGNS = SIGN_SPECS.map((s) => {
  const oc = ensureWallBackedCell(s.col, s.row, s.side);
  const snapped = snapToBackingWall(oc.col, oc.row, s.side, 0.04);
  return { x: snapped.x, z: snapped.z, rotY: snapped.rotY, text: s.text, sub: s.sub, color: s.color };
});

// 4. Декоративные объекты (каждый в СВОЕЙ выделенной клетке, строго прижат к стене, реальные компактные хитбоксы!)
const DECOR_SPECS = [
  // Центральный узел (спавн): 2 больших стола со скамьями ровно в центре СЗ и СВ зон (как на референсе!),
  // плюс обычные столы у стен и декоративные растения по углам!
  { col: 12, row: 9, side: null, type: 'dining_table', w: 2.5, d: 1.9, center: true },
  { col: 14, row: 9, side: null, type: 'dining_table', w: 2.5, d: 1.9, center: true },
  { col: 11, row: 8, side: 'N', type: 'plain_table', w: 1.8, d: 0.9 },
  { col: 15, row: 8, side: 'N', type: 'plain_table', w: 1.8, d: 0.9 },
  { col: 11, row: 9, side: 'W', type: 'potted_plant', w: 0.7, d: 0.7 },
  { col: 15, row: 9, side: 'E', type: 'potted_plant', w: 0.7, d: 0.7 },
  { col: 11, row: 11, side: 'W', type: 'bench', w: 0.7, d: 2.0 },
  { col: 15, row: 11, side: 'E', type: 'plain_table', w: 0.9, d: 1.8 },
  { col: 12, row: 11, side: 'S', type: 'potted_plant', w: 0.7, d: 0.7 },

  // Западная лаборатория
  { col: 5, row: 7, side: 'W', type: 'lab_console', w: 0.85, d: 1.6 },
  { col: 9, row: 12, side: 'S', type: 'barrel_pair', w: 1.0, d: 0.9 },
  { col: 8, row: 7, side: 'N', type: 'power_cabinet', w: 1.4, d: 0.7 },
  { col: 5, row: 12, side: 'S', type: 'potted_plant', w: 0.7, d: 0.7 },

  // Столовая и Кухня (2 больших стола со скамьями + раздача + холодильник + растение)
  { col: 2, row: 9, side: null, type: 'dining_table', w: 2.5, d: 1.9, center: true },
  { col: 2, row: 11, side: null, type: 'dining_table', w: 2.5, d: 1.9, center: true },
  { col: 3, row: 8, side: 'N', type: 'potted_plant', w: 0.7, d: 0.7 },
  { col: 1, row: 14, side: 'W', type: 'kitchen_counter', w: 0.9, d: 2.6 },
  { col: 1, row: 16, side: 'S', type: 'kitchen_fridge', w: 1.0, d: 0.85 },

  // Генераторный блок
  { col: 18, row: 12, side: 'S', type: 'power_cabinet', w: 1.4, d: 0.7 },
  { col: 20, row: 14, side: 'S', type: 'barrel_pair', w: 1.0, d: 0.9 },
  { col: 18, row: 8, side: 'N', type: 'crate_stack', w: 1.2, d: 1.2 },

  // Медотсек (койки, медшкаф, столик и растение)
  { col: 25, row: 10, side: 'E', type: 'med_bed', w: 1.8, d: 0.95 },
  { col: 25, row: 12, side: 'E', type: 'med_bed', w: 1.8, d: 0.95 },
  { col: 23, row: 13, side: 'S', type: 'med_cabinet', w: 1.2, d: 0.6 },
  { col: 23, row: 8, side: 'N', type: 'potted_plant', w: 0.7, d: 0.7 },
  { col: 25, row: 13, side: 'E', type: 'plain_table', w: 0.9, d: 1.6 },

  // Южный архив и ЮЗ тоннель
  { col: 16, row: 13, side: 'N', type: 'crate_stack', w: 1.2, d: 1.2 },
  { col: 6, row: 16, side: 'W', type: 'barrel_pair', w: 1.0, d: 0.9 },

  // Насосная
  { col: 9, row: 23, side: 'W', type: 'pump_tank', w: 1.5, d: 1.5 },
  { col: 17, row: 23, side: 'E', type: 'pump_tank', w: 1.5, d: 1.5 },

  // Серверная: аккуратные ряды двусторонних стоек + пульт
  { col: 6, row: 3, side: 'W', type: 'server_bank', w: 0.9, d: 2.4 },
  { col: 6, row: 5, side: 'W', type: 'server_bank', w: 0.9, d: 2.4 },
  { col: 8, row: 3, side: 'E', type: 'server_bank', w: 0.9, d: 2.4 },
  { col: 8, row: 5, side: 'E', type: 'lab_console', w: 0.85, d: 1.6 },

  // Комната охраны: пульт, обычный стол, скамья, силовой шкаф и растение
  { col: 23, row: 17, side: 'E', type: 'lab_console', w: 0.85, d: 1.6 },
  { col: 19, row: 18, side: 'W', type: 'bench', w: 0.7, d: 2.0 },
  { col: 23, row: 18, side: 'S', type: 'power_cabinet', w: 1.4, d: 0.7 },
  { col: 19, row: 17, side: 'N', type: 'potted_plant', w: 0.7, d: 0.7 },
  // Заполнение пустого угла возле Серверной (col 9, row 7 и col 5, row 7)
  { col: 9, row: 7, side: 'N', type: 'crates', w: 0.95, d: 0.8 },
  { col: 9, row: 7, side: 'E', type: 'potted_plant', w: 0.7, d: 0.7 },
  { col: 5, row: 7, side: 'W', type: 'barrels', w: 0.75, d: 0.75 },
];

const RESERVED_CELLS = new Set();
const DECOR_PROPS = DECOR_SPECS.map((d) => {
  const oc = ensureOpenCell(d.col, d.row);
  RESERVED_CELLS.add(`${oc.col},${oc.row}`);
  if (d.center) {
    const pos = gridToWorld(oc.col, oc.row);
    return { type: d.type, x: pos.x, z: pos.z, w: d.w, d: d.d, rotY: 0, centerOk: true };
  }
  const inset = Math.min(d.w, d.d) / 2 + 0.08;
  const snapped = snapToBackingWall(oc.col, oc.row, d.side, inset);
  return { type: d.type, x: snapped.x, z: snapped.z, w: d.w, d: d.d, rotY: snapped.rotY };
});

// 5. Шкафчики (каждый в СВОЕЙ выделенной клетке, автоматически прижат к стене, 0 пересечений!)
const LOCKER_CELLS = [
  { id: 'locker_1', col: 13, row: 4, side: 'W' },
  { id: 'locker_2', col: 14, row: 11, side: 'S' },  // В Центральном узле
  { id: 'locker_3', col: 6, row: 11, side: 'E' },   // Западная лаборатория
  { id: 'locker_4', col: 9, row: 10, side: 'N' },   // Западная лаборатория
  { id: 'locker_5', col: 1, row: 9, side: 'W' },    // Столовая
  { id: 'locker_6', col: 3, row: 15, side: 'E' },   // Кухня
  { id: 'locker_7', col: 19, row: 8, side: 'N' },   // Генераторный блок (строго у северной стены!)
  { id: 'locker_8', col: 17, row: 10, side: 'S' },  // Генераторный блок
  { id: 'locker_9', col: 23, row: 11, side: 'W' },  // Медотсек
  { id: 'locker_10', col: 25, row: 8, side: 'N' },  // Медотсек
  { id: 'locker_11', col: 6, row: 18, side: 'W' },  // ЮЗ тоннель
  { id: 'locker_12', col: 11, row: 19, side: 'W' }, // Южный архив
  { id: 'locker_13', col: 17, row: 16, side: 'E' }, // Южный архив
  { id: 'locker_14', col: 10, row: 21, side: 'N' }, // Насосная
  { id: 'locker_15', col: 6, row: 4, side: 'W' },   // Серверная (не перекрывает табличку!)
  { id: 'locker_16', col: 21, row: 18, side: 'S' }, // Комната охраны
];
LOCKER_CELLS.forEach((l) => { const oc = ensureOpenCell(l.col, l.row); l.col = oc.col; l.row = oc.row; RESERVED_CELLS.add(`${oc.col},${oc.row}`); });

// 6. Двери — автоматически компилируются из клеток 'A', '1', 'C', 'K', 'P' шириной ровно в 1 клетку (3.6м)!
function buildDoorsFromGrid() {
  const doors = [];
  let openIdx = 0;
  let kIdx = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const ch = STATION_GRID[r][c];
      if (!'A1CKPM'.includes(ch)) continue;
      RESERVED_CELLS.add(`${c},${r}`);
      const pos = gridToWorld(c, r);
      const wallsLR = getCell(c - 1, r) === '#' && getCell(c + 1, r) === '#';
      const rotY = wallsLR ? 0 : Math.PI / 2;

      if (ch === 'A') {
        doors.push({ id: 'door_airlock', type: 'door', label: 'Шлюз «Альфа» (нужны 7 генераторов)', x: pos.x, z: pos.z, rotY, width: CELL_SIZE - 0.1, state: { isOpen: false, locked: true, requiresRelays: 7 } });
      } else if (ch === '1') {
        const meta = c < 13
          ? { id: 'door_west', label: 'Гермодверь: Западная лаборатория' }
          : c < 20
            ? { id: 'door_east', label: 'Гермодверь: Генераторный блок' }
            : { id: 'door_medbay', label: 'Гермодверь: Медотсек' };
        doors.push({ id: meta.id, type: 'door', label: meta.label, x: pos.x, z: pos.z, rotY, width: CELL_SIZE - 0.1, state: { isOpen: false, locked: false } });
      } else if (ch === 'C') {
        doors.push({ id: 'door_canteen', type: 'door', label: 'Столовая (нужна карта от столовой)', x: pos.x, z: pos.z, rotY, width: CELL_SIZE - 0.1, state: { isOpen: false, locked: true, requiredKeycardId: 'keycard_canteen', requiredKeycardName: 'ключ-карта от столовой' } });
      } else if (ch === 'K') {
        const isMain = kIdx++ === 0;
        doors.push({
          id: isMain ? 'door_south' : 'door_sw_archive',
          type: 'door',
          label: isMain ? 'Склад / Архив (нужна карта от склада)' : 'Техшлюз склада (нужна карта от склада)',
          x: pos.x, z: pos.z, rotY, width: CELL_SIZE - 0.1,
          state: { isOpen: false, locked: true, requiredKeycardId: 'keycard_archive', requiredKeycardName: 'ключ-карта от склада' },
        });
      } else if (ch === 'P') {
        doors.push({ id: 'door_pump', type: 'door', label: 'Насосная (нужна карта от насосной)', x: pos.x, z: pos.z, rotY, width: CELL_SIZE - 0.1, state: { isOpen: false, locked: true, requiredKeycardId: 'keycard_pump', requiredKeycardName: 'ключ-карта от насосной' } });
      } else if (ch === 'M') {
        const isServer = r < 10;
        doors.push({
          id: isServer ? 'door_server' : 'door_security',
          type: 'door',
          label: isServer ? 'Серверная (взлом замка)' : 'Комната охраны (взлом замка)',
          x: pos.x, z: pos.z, rotY, width: CELL_SIZE - 0.1,
          state: { isOpen: false, locked: false, requiresHack: true },
        });
      }
    }
  }
  return doors;
}

const COMPILED_DOORS = buildDoorsFromGrid();
const TERM_POS = snapToBackingWall(13, 2, 'N', 0.65);
RESERVED_CELLS.add('13,2');
const LIGHT_BREAKER_POS = snapToBackingWall(8, 4, 'E', 0.25);
RESERVED_CELLS.add('8,4');
const SEC_TERM_POS = snapToBackingWall(21, 17, 'N', 0.35);
RESERVED_CELLS.add('21,17');
const SRV_SCAN_POS = snapToBackingWall(6, 3, 'N', 0.35);
RESERVED_CELLS.add('6,3');
const PUMP_VALVE_POS = snapToBackingWall(13, 23, 'S', 0.32);
RESERVED_CELLS.add('13,23');

function hasSolidBackingWall(col, row, side) {
  const off = { N: [0, -1], S: [0, 1], W: [-1, 0], E: [1, 0] }[side];
  if (!off) return false;
  return getCell(col + off[0], row + off[1]) === '#';
}

const LOOT_CABINET_CELLS = [
  { id: 'cab_arch_1', col: 11, row: 13, side: 'N' },
  { id: 'cab_arch_2', col: 15, row: 13, side: 'N' },
  { id: 'cab_arch_3', col: 17, row: 15, side: 'E' },
  { id: 'cab_arch_4', col: 9, row: 17, side: 'W' },
  { id: 'cab_canteen_1', col: 1, row: 11, side: 'W' },
  { id: 'cab_canteen_2', col: 2, row: 8, side: 'N' },
  { id: 'cab_medbay_1', col: 25, row: 9, side: 'E' },
  { id: 'cab_medbay_2', col: 25, row: 14, side: 'E' },
  { id: 'cab_pump_1', col: 11, row: 23, side: 'S' },
  { id: 'cab_pump_2', col: 15, row: 23, side: 'S' },
  { id: 'cab_sec', col: 22, row: 18, side: 'S' },
  { id: 'cab_srv', col: 7, row: 3, side: 'N' },
  { id: 'cab_east', col: 19, row: 12, side: 'W' },
  { id: 'cab_west', col: 7, row: 12, side: 'W' },
].filter((c) => getCell(c.col, c.row) === '.' && hasSolidBackingWall(c.col, c.row, c.side) && !RESERVED_CELLS.has(`${c.col},${c.row}`));
for (const c of LOOT_CABINET_CELLS) RESERVED_CELLS.add(`${c.col},${c.row}`);

// 5 открытых проверяемых коробок на стеллажах склада (S-клетки, стоят прямо на полке у прохода)
const SHELF_LOOT_BOXES = [
  { id: 'sbox_1', col: 10, row: 14, offsetZ: -0.35, rotY: 0 },
  { id: 'sbox_2', col: 15, row: 14, offsetZ: 0.35, rotY: Math.PI },
  { id: 'sbox_3', col: 13, row: 16, offsetZ: -0.35, rotY: 0 },
  { id: 'sbox_4', col: 11, row: 18, offsetZ: 0.35, rotY: Math.PI },
  { id: 'sbox_5', col: 15, row: 18, offsetZ: -0.35, rotY: 0 },
].filter((b) => getCell(b.col, b.row) === 'S');

const INITIAL_OBJECTS = [
  ...COMPILED_DOORS,

  // 3 ключ-карты (позиции рандомизируются по уникальным клеткам!)
  { id: 'keycard_canteen', type: 'keycard', label: 'Ключ-карта от столовой', x: 0, z: 0, rotY: 0, state: { pickedUp: false, cardName: 'ключ-карта от столовой', unlocksDoors: ['door_canteen'] } },
  { id: 'keycard_archive', type: 'keycard', label: 'Ключ-карта от склада', x: 0, z: 0, rotY: 0, state: { pickedUp: false, cardName: 'ключ-карта от склада', unlocksDoors: ['door_south', 'door_sw_archive'] } },
  { id: 'keycard_pump', type: 'keycard', label: 'Ключ-карта от насосной', x: 0, z: 0, rotY: 0, state: { pickedUp: false, cardName: 'ключ-карта от насосной', unlocksDoors: ['door_pump'] } },

  // 7 генераторов
  { id: 'relay_1', type: 'relay', label: 'Генератор №1', x: 0, z: 0, rotY: 0, state: { active: false } },
  { id: 'relay_2', type: 'relay', label: 'Генератор №2', x: 0, z: 0, rotY: 0, state: { active: false } },
  { id: 'relay_3', type: 'relay', label: 'Генератор №3', x: 0, z: 0, rotY: 0, state: { active: false } },
  { id: 'relay_4', type: 'relay', label: 'Генератор №4', x: 0, z: 0, rotY: 0, state: { active: false } },
  { id: 'relay_5', type: 'relay', label: 'Генератор №5', x: 0, z: 0, rotY: 0, state: { active: false } },
  { id: 'relay_6', type: 'relay', label: 'Генератор №6', x: 0, z: 0, rotY: 0, state: { active: false } },
  { id: 'relay_7', type: 'relay', label: 'Генератор №7', x: 0, z: 0, rotY: 0, state: { active: false } },

  { id: 'evac_terminal', type: 'evac_terminal', label: 'Терминал подъёмника (код)', x: TERM_POS.x, z: TERM_POS.z, rotY: TERM_POS.rotY, state: { activated: false } },
  { id: 'light_breaker', type: 'light_breaker', label: 'Рубильник освещения', x: LIGHT_BREAKER_POS.x, z: LIGHT_BREAKER_POS.z, rotY: LIGHT_BREAKER_POS.rotY, state: { powerOn: true } },
  { id: 'sec_terminal', type: 'sec_terminal', label: 'Пульт охраны (задержка Волны)', x: SEC_TERM_POS.x, z: SEC_TERM_POS.z, rotY: SEC_TERM_POS.rotY, state: { cooldownUntil: 0 } },
  { id: 'srv_scanner', type: 'srv_scanner', label: 'Сканер секторов', x: SRV_SCAN_POS.x, z: SRV_SCAN_POS.z, rotY: SRV_SCAN_POS.rotY, state: { cooldownUntil: 0 } },
  { id: 'pump_valve', type: 'pump_valve', label: 'Паровой вентиль', x: PUMP_VALVE_POS.x, z: PUMP_VALVE_POS.z, rotY: PUMP_VALVE_POS.rotY, state: { closed: false } },

  // 10 шкафчиков (автоматически прижаты к стенам)
  ...LOCKER_CELLS.map((l) => {
    const s = snapToBackingWall(l.col, l.row, l.side, 0.42);
    return { id: l.id, type: 'locker', label: 'Шкафчик', x: s.x, z: s.z, rotY: s.rotY, state: {} };
  }),

  // Настенные шкафчики снабжения для обыска (строго прижаты к капитальным стенам '#'!)
  ...LOOT_CABINET_CELLS.map((c) => {
    const s = snapToBackingWall(c.col, c.row, c.side, 0.16);
    return { id: c.id, type: 'loot_cabinet', label: 'Шкафчик снабжения', x: s.x, z: s.z, rotY: s.rotY, col: c.col, row: c.row, side: c.side, state: { searched: false, lootItem: null } };
  }),

  // Открытые коробки на полках склада (можно проверять)
  ...SHELF_LOOT_BOXES.map((b) => {
    const p = gridToWorld(b.col, b.row);
    return { id: b.id, type: 'loot_box', label: 'Открытая коробка', x: p.x, z: p.z + b.offsetZ, rotY: b.rotY, state: { searched: false, lootItem: null } };
  }),

  // 4 стола с цифрами кода
  { id: 'note_1', type: 'note', label: 'Запись дежурного', x: 0, z: 0, rotY: 0, state: { codeIndex: 0, title: 'Журнал смены', text: 'Когда по коридорам пойдёт низкий гул — прячься в шкаф или присядь без света.' } },
  { id: 'note_2', type: 'note', label: 'Записка из пищеблока', x: 0, z: 0, rotY: 0, state: { codeIndex: 1, title: 'Листок на кухне', text: 'Ключ от нижнего коллектора унесли перед эвакуацией.' } },
  { id: 'note_3', type: 'note', label: 'Сводка архива', x: 0, z: 0, rotY: 0, state: { codeIndex: 2, title: 'Сводка энергетика', text: 'На шлюз «Альфа» нужно вывести все 7 генераторов.' } },
  { id: 'note_4', type: 'note', label: 'Записка Маркова', x: 0, z: 0, rotY: 0, state: { codeIndex: 3, title: 'Запись Маркова', text: 'Не верь силуэту в костюме напарника, если он молчит.' } },
];

// 7. Потолочные лампы — СТРОГО на открытых проходимых клетках (НИКОГДА в стене!)
const LIGHT_CELLS = [
  { col: 13, row: 10, color: 0xbfe2f5, intensity: 16, distance: 16 }, // Центр хаба
  { col: 13, row: 5, color: 0x9fcbe0, intensity: 11, distance: 13 },  // Сев. коридор
  { col: 13, row: 1, color: 0x7ef2cc, intensity: 14, distance: 13 },  // Шлюз Альфа
  { col: 16, row: 6, color: 0x9bb8cc, intensity: 11, distance: 14 },  // СВ тоннель
  { col: 7, row: 7, color: 0x9fd0e8, intensity: 12, distance: 14 },   // Запад верх
  { col: 7, row: 10, color: 0x89bad6, intensity: 12, distance: 14 },  // Запад центр
  { col: 8, row: 14, color: 0x89bad6, intensity: 11, distance: 14 },  // Запад юг
  { col: 2, row: 9, color: 0xf4cf8b, intensity: 12, distance: 14 },   // Столовая
  { col: 2, row: 14, color: 0xe6b873, intensity: 12, distance: 14 },  // Кухня
  { col: 19, row: 8, color: 0xf0be7a, intensity: 12, distance: 14 },  // Восток верх
  { col: 19, row: 10, color: 0xf0a862, intensity: 12, distance: 14 }, // Восток центр
  { col: 19, row: 14, color: 0xf0a862, intensity: 11, distance: 14 }, // Восток юг
  { col: 24, row: 10, color: 0x8ef0d0, intensity: 12, distance: 14 }, // Медотсек север
  { col: 24, row: 14, color: 0x86e0c8, intensity: 12, distance: 14 }, // Медотсек юг
  { col: 7, row: 18, color: 0xd8886a, intensity: 11, distance: 14 },  // ЮЗ тоннель
  { col: 13, row: 16, color: 0xa2c6db, intensity: 12, distance: 15 }, // Архив север
  { col: 13, row: 20, color: 0x93b8cf, intensity: 12, distance: 15 }, // Архив юг
  { col: 13, row: 23, color: 0x7ab4e8, intensity: 13, distance: 15 }, // Насосная
  { col: 7, row: 4, color: 0x7dd3fc, intensity: 12, distance: 14 },  // Серверная
  { col: 21, row: 17, color: 0xfcd34d, intensity: 12, distance: 14 }, // Комната охраны
];

const LIGHT_FIXTURES = LIGHT_CELLS.map((l, i) => {
  const oc = ensureOpenCell(l.col, l.row);
  const pos = gridToWorld(oc.col, oc.row);
  return { id: `l_${i}`, x: pos.x, z: pos.z, color: l.color, intensity: l.intensity, distance: l.distance };
});

// 8. Автоматический сбор ВСЕХ свободных '.' клеток у стен '#' по секторам (0 ошибок, 0 наложений!)
function classifyGridCell(col, row) {
  if (row <= 3) return 'airlock';
  if (col === 13 && row >= 4 && row <= 7) return 'north';
  if (row === 6 && col >= 14) return 'tunnels';
  if (col >= 11 && col <= 15 && row >= 8 && row <= 11) return 'hub';
  if (col <= 3 && row >= 8 && row <= 16) return 'canteen';
  if (col >= 23 && row >= 8 && row <= 13) return 'medbay';
  if (col >= 5 && col <= 7 && row >= 13 && row <= 19) return 'tunnels';
  if (col >= 5 && col <= 9 && row >= 3 && row <= 12) return 'west';
  if (col >= 9 && col <= 17 && row >= 13 && row <= 19) return 'archive';
  if ((col >= 17 && col <= 21 && row >= 7 && row <= 15) || (col >= 19 && col <= 23 && row >= 16 && row <= 18)) return 'east';
  if (row >= 21) return 'pump';
  return 'other';
}

const AUTO_BY_ZONE = { west: [], east: [], medbay: [], tunnels: [], canteen: [], archive: [], pump: [] };
for (let r = 1; r < ROWS - 1; r++) {
  for (let c = 1; c < COLS - 1; c++) {
    if (STATION_GRID[r][c] !== '.') continue;
    if (RESERVED_CELLS.has(`${c},${r}`)) continue;
    // Не ставим прямо впритык к дверям ('A','1','C','K','P') или приседу ('b')
    const nearSpecial = [
      getCell(c-1, r), getCell(c+1, r), getCell(c, r-1), getCell(c, r+1),
    ].some((ch) => 'A1CKPMb'.includes(ch));
    if (nearSpecial) continue;
    const sides = [
      { name: 'N', ch: getCell(c, r - 1) },
      { name: 'S', ch: getCell(c, r + 1) },
      { name: 'W', ch: getCell(c - 1, r) },
      { name: 'E', ch: getCell(c + 1, r) },
    ].filter((s) => s.ch === '#');
    if (sides.length === 0) continue;
    const z = classifyGridCell(c, r);
    if (AUTO_BY_ZONE[z]) {
      AUTO_BY_ZONE[z].push({ col: c, row: r, side: sides[0].name });
    }
  }
}

const RELAY_CELL_POOLS = {
  west: AUTO_BY_ZONE.west,
  east: AUTO_BY_ZONE.east,
  medbay: AUTO_BY_ZONE.medbay,
  tunnels: AUTO_BY_ZONE.tunnels,
  canteen: AUTO_BY_ZONE.canteen,
  archive: AUTO_BY_ZONE.archive,
  pump: AUTO_BY_ZONE.pump,
};

// Ключ-карты с жёсткой защитой от софтлока и далеко от своей двери:
// 1. Карта от столовой — ТОЛЬКО восток (Ген. блок / Медотсек / СВ тоннель)
// 2. Карта от склада — Столовая/Кухня, Медотсек или Ген. блок (никогда в складе/насосной!)
// 3. Карта от насосной — Столовая/Кухня, Медотсек или Западная лаба (НИКОГДА в складе/насосной!)
const KEYCARD_CELL_POOLS = {
  keycard_canteen: [...AUTO_BY_ZONE.east, ...AUTO_BY_ZONE.medbay],
  keycard_archive: [...AUTO_BY_ZONE.canteen, ...AUTO_BY_ZONE.medbay, ...AUTO_BY_ZONE.east],
  keycard_pump: [...AUTO_BY_ZONE.canteen, ...AUTO_BY_ZONE.medbay, ...AUTO_BY_ZONE.west],
};

const NOTE_CELL_POOLS = {
  outerOpen: [...AUTO_BY_ZONE.medbay, ...AUTO_BY_ZONE.tunnels, ...AUTO_BY_ZONE.east],
  canteen: AUTO_BY_ZONE.canteen,
  archive: AUTO_BY_ZONE.archive,
  pump: AUTO_BY_ZONE.pump,
};

// Узлы навигации для аномалии/Эхо-Двойника (строго на открытых клетках!)
const NAV_CELLS = [
  [13, 10], [13, 5], [17, 6], [22, 8], [19, 10], [24, 10], [24, 14],
  [8, 10], [7, 7], [2, 10], [2, 14], [7, 16], [7, 18], [13, 15], [13, 20], [13, 23],
];
const NAV_NODES = NAV_CELLS.map(([c, r], id) => {
  const p = gridToWorld(c, r);
  return { id, x: p.x, z: p.z, adj: [] };
});
// Автосвязывание ближайших видимых узлов
for (let i = 0; i < NAV_NODES.length; i++) {
  for (let j = i + 1; j < NAV_NODES.length; j++) {
    const d = Math.hypot(NAV_NODES[i].x - NAV_NODES[j].x, NAV_NODES[i].z - NAV_NODES[j].z);
    if (d < 24) { NAV_NODES[i].adj.push(j); NAV_NODES[j].adj.push(i); }
  }
}

const PATROL_WAYPOINTS = NAV_NODES.map((n) => ({ x: n.x, z: n.z }));
const ANOMALY_POINTS = PATROL_WAYPOINTS;

function findNextNavTarget(fromX, fromZ, toX, toZ) {
  if (hasLineOfSight(fromX, fromZ, toX, toZ, [])) return { x: toX, z: toZ };
  const nearestNode = (x, z) => {
    let best = NAV_NODES[0], bestD = Infinity;
    for (const n of NAV_NODES) {
      const d = Math.hypot(n.x - x, n.z - z);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  };
  const start = nearestNode(fromX, fromZ);
  const goal = nearestNode(toX, toZ);
  if (start.id === goal.id) return { x: toX, z: toZ };

  const queue = [[start.id]], visited = new Set([start.id]);
  while (queue.length > 0) {
    const path = queue.shift();
    const curId = path[path.length - 1];
    if (curId === goal.id) {
      const nextNode = NAV_NODES[path[1] ?? path[0]];
      return { x: nextNode.x, z: nextNode.z };
    }
    for (const nxt of NAV_NODES[curId].adj) {
      if (!visited.has(nxt)) { visited.add(nxt); queue.push([...path, nxt]); }
    }
  }
  return { x: toX, z: toZ };
}

function getZoneAt(x, z) {
  for (const zone of ZONES) {
    if (x >= zone.minX && x <= zone.maxX && z >= zone.minZ && z <= zone.maxZ) return zone;
  }
  return { id: 'unknown', name: 'Технический переход' };
}

function hasLineOfSight(x1, z1, x2, z2, closedDoors = [], ignoreDoorId = null) {
  const boxes = [...WALLS];
  for (const door of closedDoors) {
    if (door.id === ignoreDoorId) continue;
    const isHorizontal = Math.abs(Math.cos(door.rotY || 0)) > 0.5;
    boxes.push({ x: door.x, z: door.z, w: isHorizontal ? door.width : 0.45, d: isHorizontal ? 0.45 : door.width });
  }
  const dx = x2 - x1, dz = z2 - z1, len = Math.hypot(dx, dz);
  if (len < 0.05) return true;
  const shrink = Math.min(0.28, len * 0.25);
  const ex = x2 - (dx / len) * shrink, ez = z2 - (dz / len) * shrink;
  for (const b of boxes) {
    if (segmentIntersectsAABB(x1, z1, ex, ez, b.x - b.w / 2, b.x + b.w / 2, b.z - b.d / 2, b.z + b.d / 2)) return false;
  }
  return true;
}

function segmentIntersectsAABB(x1, z1, x2, z2, minX, maxX, minZ, maxZ) {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dz = z2 - z1;
  const clip = (p, q) => {
    if (Math.abs(p) < 1e-8) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  return clip(-dx, x1 - minX) && clip(dx, maxX - x1) && clip(-dz, z1 - minZ) && clip(dz, maxZ - z1);
}

function findVisibleCorridorPoint(px, pz, yaw, closedDoors = []) {
  const dirX = -Math.sin(yaw), dirZ = -Math.cos(yaw);
  for (const dist of [7.5, 6.2, 5.0, 4.0]) {
    const cx = px + dirX * dist, cz = pz + dirZ * dist;
    const resolved = resolveMapCollision(cx, cz, closedDoors, false);
    if (Math.hypot(resolved.x - cx, resolved.z - cz) < 0.15 && hasLineOfSight(px, pz, cx, cz, closedDoors)) {
      return { x: Number(cx.toFixed(2)), z: Number(cz.toFixed(2)) };
    }
  }
  return null;
}

const OBJECT_COLLIDERS = {
  relay: [1.14, 0.78],
  locker: [0.92, 0.7],
  note: [1.12, 0.64],
  keycard: [1.04, 0.64],
  evac_terminal: [1.52, 0.76],
  sec_terminal: [0.9, 0.52],
  srv_scanner: [0.9, 0.52],
};

function resolveMapCollision(x, z, closedDoors = [], crouching = false, solidObjects = []) {
  const r = MAP_CONFIG.playerRadius;
  let nx = Math.max(MAP_CONFIG.worldBounds.minX + r, Math.min(MAP_CONFIG.worldBounds.maxX - r, x));
  let nz = Math.max(MAP_CONFIG.worldBounds.minZ + r, Math.min(MAP_CONFIG.worldBounds.maxZ - r, z));
  const boxes = [...WALLS, ...DECOR_PROPS];
  if (!crouching) boxes.push(...CROUCH_BARRIERS);
  for (const door of closedDoors) {
    const isHorizontal = Math.abs(Math.cos(door.rotY || 0)) > 0.5;
    boxes.push({ x: door.x, z: door.z, w: isHorizontal ? door.width : 0.6, d: isHorizontal ? 0.6 : door.width });
  }
  for (const obj of solidObjects) {
    const dims = OBJECT_COLLIDERS[obj.type];
    if (!dims) continue;
    const rotated90 = Math.abs(Math.sin(obj.rotY || 0)) > 0.5;
    boxes.push({
      x: obj.x,
      z: obj.z,
      w: rotated90 ? dims[1] : dims[0],
      d: rotated90 ? dims[0] : dims[1],
    });
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const b of boxes) {
      const halfW = b.w / 2, halfD = b.d / 2;
      const closestX = Math.max(b.x - halfW, Math.min(nx, b.x + halfW));
      const closestZ = Math.max(b.z - halfD, Math.min(nz, b.z + halfD));
      const dx = nx - closestX, dz = nz - closestZ, distSq = dx * dx + dz * dz;
      if (distSq < r * r) {
        const dist = Math.sqrt(distSq);
        if (dist > 0.0001) { const push = r - dist; nx += (dx / dist) * push; nz += (dz / dist) * push; }
        else {
          const penX = halfW - Math.abs(nx - b.x), penZ = halfD - Math.abs(nz - b.z);
          if (penX < penZ) nx += nx >= b.x ? penX + r : -(penX + r);
          else nz += nz >= b.z ? penZ + r : -(penZ + r);
        }
      }
    }
  }
  return { x: nx, z: nz };
}

/**
 * Клеточный генератор раскладки:
 * - Каждый объект (генератор, ключ-карта, стол с кодом) получает УНИКАЛЬНУЮ свободную клетку у стены
 *   (никогда не пересекается с шкафчиками, декором, дверями или другими объектами!).
 * - Автоматическая привязка к стене (rotY лицом в коридор).
 * - Запрет прямой видимости ближе 13м и защита от софтлока!
 */
function buildRandomizedMatchObjects(digits, rng = Math.random) {
  const shuffle = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const cellKey = (c) => `${c.col},${c.row}`;
  const isFreeCell = (c, used) => {
    const k = cellKey(c);
    if (RESERVED_CELLS.has(k) || used.has(k)) return false;
    return getCell(c.col, c.row) === '.';
  };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const clearOfAll = (cand, used, placed, inset = 0.55) => {
    if (!isFreeCell(cand, used)) return null;
    const snapped = snapToBackingWall(cand.col, cand.row, cand.side, inset);
    if (inset === 0.48) {
      // Ключ-карты и столы с кодом НЕ спавнятся прямо перед дверями (минимум 7.5м от любой двери!)
      for (const dr of COMPILED_DOORS) {
        if (dist(snapped, dr) < 7.5) return null;
      }
    }
    for (const o of placed) {
      const d = dist(snapped, o);
      if (d < 6.8) return null;
      if (d < 13.0 && hasLineOfSight(snapped.x, snapped.z, o.x, o.z, [])) return null;
    }
    return { ...cand, ...snapped };
  };

  const zoneKeys = ['west', 'east', 'medbay', 'tunnels', 'canteen', 'archive', 'pump'];
  const noteTiers = ['outerOpen', 'canteen', 'archive', 'pump'];

  let chosenRelays = null;
  let chosenKeys = null;
  let chosenNotes = null;

  for (let attempt = 0; attempt < 400; attempt++) {
    const used = new Set();
    const placed = [];
    const rList = [];
    let ok = true;

    for (const zk of zoneKeys) {
      let pick = null;
      for (const cand of shuffle(RELAY_CELL_POOLS[zk])) {
        pick = clearOfAll(cand, used, placed, 0.52);
        if (pick) break;
      }
      if (!pick) { ok = false; break; }
      used.add(cellKey(pick));
      placed.push(pick);
      rList.push(pick);
    }
    if (!ok) continue;

    const kMap = {};
    const pickedKeys = [];
    for (const kid of ['keycard_canteen', 'keycard_archive', 'keycard_pump']) {
      let pick = null;
      for (const cand of shuffle(KEYCARD_CELL_POOLS[kid])) {
        const tmp = clearOfAll(cand, used, placed, 0.48);
        if (!tmp) continue;
        const sec = classifyGridCell(tmp.col, tmp.row);
        const tooCloseToOtherKey = pickedKeys.some((pk) => dist(tmp, pk) < 22.0 || pk.sector === sec);
        if (tooCloseToOtherKey) continue;
        pick = { ...tmp, sector: sec };
        break;
      }
      if (!pick) { ok = false; break; }
      used.add(cellKey(pick));
      placed.push(pick);
      pickedKeys.push(pick);
      kMap[kid] = pick;
    }
    if (!ok) continue;

    const nList = [];
    for (const tier of noteTiers) {
      let pick = null;
      for (const cand of shuffle(NOTE_CELL_POOLS[tier])) {
        pick = clearOfAll(cand, used, placed, 0.48);
        if (pick) break;
      }
      if (!pick) { ok = false; break; }
      used.add(cellKey(pick));
      placed.push(pick);
      nList.push(pick);
    }
    if (!ok) continue;

    chosenRelays = rList;
    chosenKeys = kMap;
    chosenNotes = shuffle(nList);
    break;
  }

  if (!chosenRelays) {
    chosenRelays = zoneKeys.map((zk) => {
      const c = RELAY_CELL_POOLS[zk][0];
      return { ...c, ...snapToBackingWall(c.col, c.row, c.side, 0.52) };
    });
    chosenKeys = {
      keycard_canteen: { ...KEYCARD_CELL_POOLS.keycard_canteen[0], ...snapToBackingWall(KEYCARD_CELL_POOLS.keycard_canteen[0].col, KEYCARD_CELL_POOLS.keycard_canteen[0].row, KEYCARD_CELL_POOLS.keycard_canteen[0].side, 0.48) },
      keycard_archive: { ...KEYCARD_CELL_POOLS.keycard_archive[0], ...snapToBackingWall(KEYCARD_CELL_POOLS.keycard_archive[0].col, KEYCARD_CELL_POOLS.keycard_archive[0].row, KEYCARD_CELL_POOLS.keycard_archive[0].side, 0.48) },
      keycard_pump: { ...KEYCARD_CELL_POOLS.keycard_pump[0], ...snapToBackingWall(KEYCARD_CELL_POOLS.keycard_pump[0].col, KEYCARD_CELL_POOLS.keycard_pump[0].row, KEYCARD_CELL_POOLS.keycard_pump[0].side, 0.48) },
    };
    chosenNotes = noteTiers.map((t) => {
      const c = NOTE_CELL_POOLS[t][0];
      return { ...c, ...snapToBackingWall(c.col, c.row, c.side, 0.48) };
    });
  }

  // Выбираем 3 случайных шкафчика-ловушки (никогда в Центральном узле!)
  const trapCandidates = INITIAL_OBJECTS.filter((o) => o.type === 'locker' && o.id !== 'locker_2' && o.id !== 'locker_1');
  const trapIds = new Set(shuffle(trapCandidates).slice(0, 3).map((l) => l.id));
  const lootPool = shuffle([
    'bandage', 'bandage', 'bandage',
    'energy', 'energy',
    'battery', 'battery',
    'glowstick', 'glowstick', 'glowstick',
    null, null, null, null, null, null, null,
  ]);
  let cabIdx = 0;

  let relayIdx = 0;
  let noteIdx = 0;
  return INITIAL_OBJECTS.map((tpl) => {
    const copy = { ...tpl, state: JSON.parse(JSON.stringify(tpl.state)) };
    if (copy.type === 'relay' && chosenRelays[relayIdx]) {
      const spot = chosenRelays[relayIdx++];
      copy.x = spot.x;
      copy.z = spot.z;
      copy.rotY = spot.rotY;
      copy.label = `Генератор №${relayIdx}`;
    } else if (copy.type === 'keycard' && chosenKeys[copy.id]) {
      const spot = chosenKeys[copy.id];
      copy.x = spot.x;
      copy.z = spot.z;
      copy.rotY = spot.rotY;
    } else if (copy.type === 'note' && chosenNotes[noteIdx]) {
      const spot = chosenNotes[noteIdx++];
      copy.x = spot.x;
      copy.z = spot.z;
      copy.rotY = spot.rotY;
      if (typeof copy.state.codeIndex === 'number' && digits) {
        const idx = copy.state.codeIndex;
        copy.state.codeDigit = String(digits[idx]);
        copy.state.text = `${copy.state.text}\n\nПометка на полях: ${idx + 1} — ${digits[idx]}`;
      }
    }
    if (copy.type === 'locker') copy.state.isTrap = trapIds.has(copy.id);
    if (copy.type === 'loot_cabinet' || copy.type === 'loot_box') {
      copy.state.searched = false;
      copy.state.lootItem = lootPool[cabIdx % lootPool.length];
      cabIdx++;
    }
    return copy;
  });
}

// === SHARED: characterCatalog.js ===
/**
 * Каталог классов, пресетов скинов и пользовательского редактора костюма (Этап 3).
 */

const PLAYER_CLASSES = [
  {
    id: 'engineer',
    name: 'Инженер',
    bonus: '+25% зона генератора, -20% разряд батареи',
    genZoneBonus: 0.06,
    batteryDrainMult: 0.8,
    speedMult: 1.0,
    staminaDrainMult: 1.0,
    damageMult: 1.0,
    reviveSec: 30,
    startItem: null,
  },
  {
    id: 'medic',
    name: 'Медик',
    bonus: 'Старт с Пластырем, реанимация за 15с',
    genZoneBonus: 0,
    batteryDrainMult: 1.0,
    speedMult: 1.0,
    staminaDrainMult: 1.0,
    damageMult: 1.0,
    reviveSec: 15,
    startItem: 'bandage',
  },
  {
    id: 'scout',
    name: 'Разведчик',
    bonus: '+15% к скорости, +22% к выносливости',
    genZoneBonus: 0,
    batteryDrainMult: 1.0,
    speedMult: 1.15,
    staminaDrainMult: 0.78,
    damageMult: 1.0,
    reviveSec: 30,
    startItem: null,
  },
  {
    id: 'guard',
    name: 'Охранник',
    bonus: '-25% урона от Волны и Мимика',
    genZoneBonus: 0,
    batteryDrainMult: 1.0,
    speedMult: 1.0,
    staminaDrainMult: 1.0,
    damageMult: 0.75,
    reviveSec: 30,
    startItem: null,
  },
];

const CHARACTER_SKINS = [
  {
    id: 'random',
    name: 'Случайный',
    suitColor: 0x475569,
    accentColor: 0xf59e0b,
    visorColor: 0x7ce8ff,
    flashlightColor: 0xfff3d6,
    badgeHex: '#94a3b8',
  },
  {
    id: 'engineer',
    name: 'Синий техник',
    suitColor: 0x3b6e8c,
    accentColor: 0xf0a830,
    visorColor: 0x7ce8ff,
    flashlightColor: 0xfff3d6,
    badgeHex: '#54b7e8',
  },
  {
    id: 'acoustic',
    name: 'Изумрудный',
    suitColor: 0x456b52,
    accentColor: 0x8be29a,
    visorColor: 0xa6ffcb,
    flashlightColor: 0xe8fff2,
    badgeHex: '#63d48c',
  },
  {
    id: 'medic',
    name: 'Бордовый',
    suitColor: 0x8a4242,
    accentColor: 0xf4ece6,
    visorColor: 0xffd0b0,
    flashlightColor: 0xfff0e0,
    badgeHex: '#e87878',
  },
  {
    id: 'archivist',
    name: 'Фиолетовый',
    suitColor: 0x62507d,
    accentColor: 0xd4b8ff,
    visorColor: 0xc2d9ff,
    flashlightColor: 0xe6eaff,
    badgeHex: '#b392eb',
  },
  {
    id: 'custom',
    name: 'Свой скин',
    suitColor: 0x3b6e8c,
    accentColor: 0xf0a830,
    visorColor: 0x7ce8ff,
    flashlightColor: 0xfff3d6,
    badgeHex: '#f59e0b',
  },
];

function getClassById(id) {
  return PLAYER_CLASSES.find((c) => c.id === id) || PLAYER_CLASSES[0];
}

function parseHexColor(hex, fallback) {
  if (typeof hex === 'number') return hex;
  if (typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex)) {
    return parseInt(hex.slice(1), 16);
  }
  return fallback;
}

function getSkinById(id, customSkin = null) {
  if (id === 'custom' && customSkin) {
    return {
      id: 'custom',
      name: 'Свой скин',
      suitColor: parseHexColor(customSkin.suitHex, 0x3b6e8c),
      accentColor: parseHexColor(customSkin.accentHex, 0xf0a830),
      visorColor: parseHexColor(customSkin.visorHex, 0x7ce8ff),
      flashlightColor: 0xfff3d6,
      badgeHex: customSkin.accentHex || '#f59e0b',
    };
  }
  if (id === 'random') {
    const pool = CHARACTER_SKINS.filter((s) => s.id !== 'random' && s.id !== 'custom');
    return pool[Math.floor(Math.random() * pool.length)];
  }
  return CHARACTER_SKINS.find((s) => s.id === id) || CHARACTER_SKINS[1];
}

// === SERVER: config.js ===
/**
 * Конфигурация сервера (читает переменные окружения для Render/Railway/Docker/локального запуска).
 */

const SERVER_CONFIG = {
  host: process.env.HOST || '0.0.0.0',
  port: Number.parseInt(process.env.PORT || '3000', 10),
  maxRooms: Number.parseInt(process.env.MAX_ROOMS || '50', 10),
  tickRateHz: Number.parseInt(process.env.TICK_RATE || '15', 10),
  heartbeatIntervalMs: 15_000,
  roomIdleCleanupMs: 120_000,
};

// === SERVER: wsServer.js ===
/**
 * Лёгкий RFC 6455 WebSocket-сервер на встроенных модулях Node.js (без внешних npm-зависимостей).
 * Поддерживает: handshake, текстовые фреймы (до 64 КБ), фрагментацию/маскирование,
 * ping/pong heartbeat, корректное закрытие и защиту от повреждённых пакетов и обрывов EPIPE.
 */


const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WebSocketClient extends EventEmitter {
  constructor(socket, request) {
    super();
    this.socket = socket;
    this.request = request;
    this.readyState = 1; // OPEN
    this.isAlive = true;
    this._buffer = Buffer.alloc(0);

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._handleClose(1006, 'Connection closed'));
    socket.on('error', (err) => {
      if (this.listenerCount('error') > 0) {
        this.emit('error', err);
      }
      this._handleClose(1006, 'Socket error');
    });
  }

  send(data) {
    if (this.readyState !== 1 || !this.socket.writable || this.socket.destroyed) return false;
    const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const frame = encodeFrame(0x1, payload);
    try {
      this.socket.write(frame);
      return true;
    } catch {
      this._handleClose(1006, 'Write failed');
      return false;
    }
  }

  sendJSON(obj) {
    return this.send(JSON.stringify(obj));
  }

  ping() {
    if (this.readyState !== 1 || !this.socket.writable || this.socket.destroyed) return;
    try {
      this.socket.write(encodeFrame(0x9, Buffer.alloc(0)));
    } catch {
      this._handleClose(1006, 'Ping failed');
    }
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    const reasonBuf = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    try {
      if (this.socket.writable && !this.socket.destroyed) {
        this.socket.write(encodeFrame(0x8, payload));
        this.socket.end();
      }
    } catch {
      // ignore
    }
    this._handleClose(code, reason);
  }

  _handleClose(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', code, reason);
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);

    // Защита от переполнения памяти
    if (this._buffer.length > 256 * 1024) {
      this.close(1009, 'Message too big');
      return;
    }

    while (this._buffer.length >= 2) {
      const firstByte = this._buffer[0];
      const secondByte = this._buffer[1];
      const opcode = firstByte & 0x0f;
      const masked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this._buffer.length < 4) return;
        payloadLen = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._buffer.length < 10) return;
        const high = this._buffer.readUInt32BE(2);
        const low = this._buffer.readUInt32BE(6);
        if (high !== 0 || low > 65536) {
          this.close(1009, 'Frame too large');
          return;
        }
        payloadLen = low;
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      const totalLen = offset + maskLen + payloadLen;
      if (this._buffer.length < totalLen) return;

      let maskKey = null;
      if (masked) {
        maskKey = this._buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      const payload = Buffer.from(this._buffer.subarray(offset, offset + payloadLen));
      this._buffer = this._buffer.subarray(totalLen);

      if (masked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i & 3];
        }
      }

      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        this.close(code, reason);
        return;
      } else if (opcode === 0x9) {
        this.isAlive = true;
        try {
          if (this.socket.writable && !this.socket.destroyed) {
            this.socket.write(encodeFrame(0xa, payload));
          }
        } catch {
          this._handleClose(1006, 'Pong failed');
        }
      } else if (opcode === 0xa) {
        this.isAlive = true;
      } else if (opcode === 0x1) {
        this.isAlive = true;
        this.emit('message', payload.toString('utf8'));
      }
    }
  }
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

class WebSocketServer extends EventEmitter {
  constructor(httpServer, { heartbeatIntervalMs = 15_000 } = {}) {
    super();
    this.clients = new Set();

    httpServer.on('upgrade', (req, socket) => {
      const upgradeHeader = (req.headers.upgrade || '').toLowerCase();
      const wsKey = req.headers['sec-websocket-key'];
      if (upgradeHeader !== 'websocket' || !wsKey) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }

      const acceptKey = crypto
        .createHash('sha1')
        .update(wsKey + WS_GUID)
        .digest('base64');

      const headers = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey}`,
        '\r\n',
      ];
      socket.write(headers.join('\r\n'));

      const client = new WebSocketClient(socket, req);
      this.clients.add(client);
      client.on('close', () => this.clients.delete(client));
      this.emit('connection', client, req);
    });

    this._heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        if (!client.isAlive) {
          client.close(1001, 'Heartbeat timeout');
          continue;
        }
        client.isAlive = false;
        client.ping();
      }
    }, heartbeatIntervalMs);
    this._heartbeatTimer.unref?.();
  }

  close() {
    clearInterval(this._heartbeatTimer);
    for (const client of this.clients) {
      client.close(1001, 'Server shutting down');
    }
    this.clients.clear();
  }
}

// === SERVER: eventDefinitions.js ===
/**
 * Расширяемый реестр хоррор-событий (общие, индивидуальные и динамические).
 * Личный фантом теперь проверяет геометрию коридора и не появляется внутри стен.
 */


const HORROR_EVENTS = [
  // ================= ОБЩИЕ СОБЫТИЯ =================
  {
    id: 'global_power_flicker',
    scope: EVENT_SCOPE.GLOBAL,
    cooldownMs: 30_000,
    minPlayers: 1,
    weight: 3,
    canTrigger: (ctx) => ctx.tension >= 0.15,
    buildPayload: () => ({
      effect: 'power_flicker',
      durationMs: 4200,
      sound: 'power_drop',
      subtitle: 'Напряжение в сети станции резко просело...',
    }),
  },
  {
    id: 'global_emergency_red',
    scope: EVENT_SCOPE.GLOBAL,
    cooldownMs: 52_000,
    minPlayers: 1,
    weight: 2,
    canTrigger: (ctx) => ctx.activatedRelays >= 1,
    buildPayload: () => ({
      effect: 'emergency_red',
      durationMs: 11_000,
      sound: 'klaxon_distant',
      subtitle: 'Аварийное освещение перешло в красный режим.',
    }),
  },
  {
    id: 'global_bulkhead_slam',
    scope: EVENT_SCOPE.GLOBAL,
    cooldownMs: 44_000,
    minPlayers: 1,
    weight: 2,
    canTrigger: (ctx) => ctx.openUnlockableDoors.length > 0,
    executeServer: (ctx) => {
      const door = ctx.openUnlockableDoors[Math.floor(Math.random() * ctx.openUnlockableDoors.length)];
      if (door) {
        door.state.isOpen = false;
        ctx.broadcastObject(door);
        return { doorId: door.id, doorLabel: door.label, x: door.x, z: door.z };
      }
      return null;
    },
    buildPayload: (ctx, serverResult) => ({
      effect: 'bulkhead_slam',
      doorId: serverResult?.doorId || null,
      x: serverResult?.x ?? 0,
      z: serverResult?.z ?? 0,
      durationMs: 3000,
      sound: 'metal_slam',
      subtitle: serverResult
        ? `Вдалеке с грохотом захлопнулась ${serverResult.doorLabel.toLowerCase()}.`
        : 'Где-то в глубине сектора захлопнулась переборка.',
    }),
  },
  {
    id: 'global_acoustic_hum',
    scope: EVENT_SCOPE.GLOBAL,
    cooldownMs: 38_000,
    minPlayers: 1,
    weight: 2,
    canTrigger: () => true,
    buildPayload: () => ({
      effect: 'acoustic_hum',
      durationMs: 7500,
      sound: 'sub_hum',
      subtitle: 'По стенам прошла низкая вибрация резонатора.',
    }),
  },
  {
    id: 'global_pa_broadcast',
    scope: EVENT_SCOPE.GLOBAL,
    cooldownMs: 60_000,
    minPlayers: 1,
    weight: 2,
    canTrigger: (ctx) => ctx.elapsedSec > 25,
    buildPayload: (ctx) => {
      const lines = [
        '«...повторяю: подсчёт персонала не сходится. На уровне на одного человека больше...»',
        '«...акустическая камера не заперта. Не оборачивайтесь на голос из рации...»',
        '«...реле №4 отзывается из пустого архива. Кто там находится?..»',
      ];
      return {
        effect: 'pa_broadcast',
        durationMs: 6500,
        sound: 'radio_static',
        subtitle: lines[ctx.eventCounter % lines.length],
      };
    },
  },

  // ================= ИНДИВИДУАЛЬНЫЕ СОБЫТИЯ =================
  {
    id: 'solo_phantom_footsteps',
    scope: EVENT_SCOPE.INDIVIDUAL,
    cooldownMs: 26_000,
    minPlayers: 1,
    weight: 3,
    canTrigger: () => true,
    selectTarget: (ctx) => ctx.pickMostIsolatedOrRandom(),
    buildPayload: (ctx, _res, target) => ({
      effect: 'phantom_footsteps',
      x: target.x - Math.sin(target.yaw) * 3.5,
      z: target.z - Math.cos(target.yaw) * 3.5,
      durationMs: 4500,
      sound: 'steps_behind',
      subtitle: 'Прямо за вашей спиной прозвучали тяжёлые шаги — но там никого нет.',
      composureDelta: -10,
    }),
  },
  {
    id: 'solo_personal_silhouette',
    scope: EVENT_SCOPE.INDIVIDUAL,
    cooldownMs: 40_000,
    minPlayers: 1,
    weight: 3,
    canTrigger: (ctx) => ctx.elapsedSec > 18,
    selectTarget: (ctx) => ctx.pickMostIsolatedOrRandom(),
    buildPayload: (ctx, _res, target) => {
      const closedDoors = ctx.room.getClosedDoors();
      const pt = findVisibleCorridorPoint(target.x, target.z, target.yaw, closedDoors);
      if (!pt) {
        // Если игрок смотрит вплотную в стену — заменяем визуальный фантом на шёпот рядом
        return {
          effect: 'phantom_footsteps',
          durationMs: 4000,
          sound: 'whisper_close',
          subtitle: 'У самого уха кто-то тихо выдохнул... и стих.',
          composureDelta: -9,
        };
      }
      return {
        effect: 'personal_silhouette',
        x: pt.x,
        z: pt.z,
        durationMs: 4800,
        sound: 'whisper_close',
        subtitle: 'В конце коридора на мгновение замер высокий силуэт. Остальные его не видят.',
        composureDelta: -14,
      };
    },
  },
  {
    id: 'solo_false_radio',
    scope: EVENT_SCOPE.INDIVIDUAL,
    cooldownMs: 36_000,
    minPlayers: 2,
    weight: 3,
    canTrigger: (ctx) => ctx.activePlayers.length >= 2,
    selectTarget: (ctx) => ctx.pickMostIsolatedOrRandom(),
    buildPayload: (ctx, _res, target) => {
      const others = ctx.activePlayers.filter((p) => p.id !== target.id);
      const fakeSender = others[Math.floor(Math.random() * others.length)];
      const phrases = [
        'Ты почему стоишь ко мне спиной?',
        'Не заходи туда, я видел, как там погас свет.',
        'Подожди... а кто только что прошёл мимо тебя?',
      ];
      return {
        effect: 'false_radio',
        fakeSenderName: fakeSender ? fakeSender.name : 'Неизвестный',
        fakeMessage: phrases[Math.floor(Math.random() * phrases.length)],
        durationMs: 5500,
        sound: 'radio_glitch',
        subtitle: 'В вашей гарнитуре прорвалась странная передача...',
        composureDelta: -8,
      };
    },
  },
  {
    id: 'solo_flashlight_die',
    scope: EVENT_SCOPE.INDIVIDUAL,
    cooldownMs: 42_000,
    minPlayers: 1,
    weight: 2,
    canTrigger: (ctx) => ctx.tension >= 0.25,
    selectTarget: (ctx) => ctx.pickMostIsolatedOrRandom(),
    buildPayload: () => ({
      effect: 'flashlight_glitch',
      durationMs: 5200,
      sound: 'bulb_buzz',
      subtitle: 'Ваш фонарь начал мерцать и затухать сам по себе.',
      composureDelta: -6,
    }),
  },

  // ================= ДИНАМИЧЕСКИЕ СОБЫТИЯ =================
  {
    id: 'dynamic_isolation_dread',
    scope: EVENT_SCOPE.DYNAMIC,
    targetMode: 'individual',
    cooldownMs: 26_000,
    minPlayers: 2,
    weight: 4,
    canTrigger: (ctx) => ctx.isolatedPlayers.length > 0,
    selectTarget: (ctx) => ctx.isolatedPlayers[Math.floor(Math.random() * ctx.isolatedPlayers.length)],
    buildPayload: () => ({
      effect: 'isolation_dread',
      durationMs: 6500,
      sound: 'heartbeat_heavy',
      subtitle: 'Вы отошли слишком далеко от группы. Тишина давит на уши.',
      composureDelta: -12,
    }),
  },
  {
    id: 'dynamic_relay_overload',
    scope: EVENT_SCOPE.DYNAMIC,
    targetMode: 'global',
    cooldownMs: 75_000,
    minPlayers: 1,
    weight: 2,
    canTrigger: (ctx) => ctx.activatedRelays >= 2 && ctx.activatedRelays < 4 && ctx.tension >= 0.45,
    executeServer: (ctx) => {
      const activeRelays = [];
      for (const obj of ctx.room.objects.values()) {
        if (obj.type === 'relay' && obj.state.active) activeRelays.push(obj);
      }
      if (activeRelays.length === 0) return null;
      const tripped = activeRelays[Math.floor(Math.random() * activeRelays.length)];
      tripped.state.active = false;
      ctx.broadcastObject(tripped);
      return { relayLabel: tripped.label };
    },
    buildPayload: (_ctx, res) => ({
      effect: 'power_flicker',
      durationMs: 4800,
      sound: 'power_drop',
      subtitle: res
        ? `Перегрузка сети! Выбило ${res.relayLabel.toLowerCase()} — нужно включить снова.`
        : 'Скачок напряжения едва не обесточил сектор.',
    }),
  },
  {
    id: 'dynamic_relay_surge',
    scope: EVENT_SCOPE.DYNAMIC,
    targetMode: 'global',
    cooldownMs: 8_000,
    minPlayers: 1,
    weight: 0,
    triggerOnAction: 'relay_activated',
    buildPayload: (_ctx, actionData) => ({
      effect: 'relay_surge',
      relayCount: actionData.relayCount,
      requiredRelays: actionData.requiredRelays,
      durationMs: 5000,
      sound: actionData.relayCount >= actionData.requiredRelays ? 'airlock_unlock' : 'power_surge',
      subtitle:
        actionData.relayCount >= actionData.requiredRelays
          ? 'Все 7 генераторов запущены! Шлюз «Альфа» открыт — введите 4-значный код на северном терминале.'
          : `Реле подключено (${actionData.relayCount}/${actionData.requiredRelays}). Что-то в тёмных коридорах откликнулось на скачок тока.`,
    }),
  },
];

// === SERVER: EventEngine.js ===
/**
 * Серверный движок игровых событий.
 * Управляет общими, индивидуальными и динамическими событиями на основе состояния комнаты.
 */


class EventEngine {
  constructor(room) {
    this.room = room;
    this.events = [...HORROR_EVENTS];
    this.cooldowns = new Map();
    this.nextCheckAt = 0;
    this.eventCounter = 0;
    this.tension = 0.15;
  }

  /**
   * Позволяет регистрировать новые события во время выполнения без правки ядра.
   */
  registerEvent(definition) {
    this.events.push(definition);
  }

  reset() {
    this.cooldowns.clear();
    this.eventCounter = 0;
    this.tension = 0.15;
    this.nextCheckAt = Date.now() + 12_000;
  }

  /**
   * Вызывается по тику сервера, пока сессия активна.
   */
  tick(now, elapsedSec) {
    // Плавный рост напряжения со временем и по мере активации реле
    const activatedRelays = this.room.getActivatedRelayCount();
    this.tension = Math.min(1.0, 0.15 + elapsedSec / 360 + activatedRelays * 0.16);

    if (now < this.nextCheckAt) return;

    const ctx = this._buildContext(elapsedSec, activatedRelays);
    if (ctx.activePlayers.length === 0) return;

    const candidates = this.events.filter((ev) => {
      if (!ev.weight || ev.weight <= 0) return false;
      if (ctx.activePlayers.length < (ev.minPlayers || 1)) return false;
      const last = this.cooldowns.get(ev.id) || 0;
      if (now - last < (ev.cooldownMs || 20_000)) return false;
      return ev.canTrigger ? ev.canTrigger(ctx) : true;
    });

    if (candidates.length > 0) {
      const chosen = weightedPick(candidates);
      this._dispatchEvent(chosen, ctx, now);
    }

    // Частота событий адаптируется к напряжению (11–20 сек, чтобы оставлять паузы тишины)
    const minWait = Math.max(9_000, 18_000 - this.tension * 7_000);
    const maxWait = minWait + 8_000;
    this.nextCheckAt = now + minWait + Math.random() * (maxWait - minWait);
  }

  /**
   * Запуск динамического события по игровому действию (например, активация реле).
   */
  triggerAction(actionName, actionData = {}) {
    const now = Date.now();
    const matching = this.events.filter((ev) => ev.triggerOnAction === actionName);
    if (matching.length === 0) return;

    const ctx = this._buildContext(this.room.getElapsedSeconds(), this.room.getActivatedRelayCount());
    for (const ev of matching) {
      this._dispatchEvent(ev, ctx, now, actionData);
    }
  }

  _dispatchEvent(ev, ctx, now, actionData = null) {
    this.cooldowns.set(ev.id, now);
    this.eventCounter++;

    const serverResult = ev.executeServer ? ev.executeServer(ctx, actionData) : actionData;
    const isIndividual =
      ev.scope === EVENT_SCOPE.INDIVIDUAL ||
      (ev.scope === EVENT_SCOPE.DYNAMIC && ev.targetMode === 'individual');

    if (isIndividual) {
      const target = ev.selectTarget ? ev.selectTarget(ctx) : ctx.pickMostIsolatedOrRandom();
      if (!target) return;

      const payload = ev.buildPayload(ctx, serverResult, target);
      if (typeof payload.composureDelta === 'number') {
        target.composure = Math.max(10, Math.min(100, target.composure + payload.composureDelta));
      }

      this.room.sendToPlayer(target.id, {
        type: MSG.HORROR_EVENT,
        eventId: ev.id,
        scope: ev.scope,
        timestamp: now,
        payload,
      });
    } else {
      const payload = ev.buildPayload(ctx, serverResult, null);
      this.room.broadcast({
        type: MSG.HORROR_EVENT,
        eventId: ev.id,
        scope: ev.scope,
        timestamp: now,
        payload,
      });
    }
  }

  _buildContext(elapsedSec, activatedRelays) {
    const activePlayers = this.room.getConnectedPlayers();
    const isolatedPlayers = [];

    // Ищем игроков, которые отошли дальше 13 м от ближайшего напарника
    if (activePlayers.length >= 2) {
      for (const p of activePlayers) {
        let minDist = Infinity;
        for (const other of activePlayers) {
          if (other.id === p.id) continue;
          const d = Math.hypot(p.x - other.x, p.z - other.z);
          if (d < minDist) minDist = d;
        }
        if (minDist > 13.0) {
          isolatedPlayers.push(p);
        }
      }
    }

    const openUnlockableDoors = [];
    for (const obj of this.room.objects.values()) {
      if (obj.type === 'door' && obj.state.isOpen && !obj.state.requiresRelays) {
        openUnlockableDoors.push(obj);
      }
    }

    return {
      room: this.room,
      activePlayers,
      isolatedPlayers,
      openUnlockableDoors,
      activatedRelays,
      elapsedSec,
      tension: this.tension,
      eventCounter: this.eventCounter,
      broadcastObject: (obj) => this.room.broadcastObjectUpdate(obj),
      pickMostIsolatedOrRandom: () => {
        if (isolatedPlayers.length > 0) {
          return isolatedPlayers[Math.floor(Math.random() * isolatedPlayers.length)];
        }
        return activePlayers[Math.floor(Math.random() * activePlayers.length)] || null;
      },
    };
  }
}

function weightedPick(items) {
  const total = items.reduce((acc, item) => acc + (item.weight || 1), 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight || 1;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

// === SERVER: AnomalyDirector.js ===
/**
 * Серверный контроллер атмосферной угрозы (v3.0 — БЕЗ бегающего монстра).
 * Две механики под голосовую игру вдвоём:
 * 1) «Эхо-Двойник» — тихая фигура (в онлайне копирует костюм напарника), стоит в коридоре и растворяется при сближении, гася свет.
 * 2) «Волна Резонанса» — раз в ~50 сек по станции нарастает невидимая акустическая волна (за 9 сек предупреждает гулом и мерцанием).
 *    Нужно переждать 5 сек в шкафчике, за закрытой дверью или в приседе с выключенным фонарём.
 */


class AnomalyDirector {
  constructor() {
    this.reset();
  }

  reset() {
    this.active = false;
    this.x = -18.0;
    this.z = 0.0;
    this.yaw = 0;
    this.mimicSkinId = 'medic';
    this.visibleUntil = 0;
    this.nextMimicAt = Date.now() + 20_000;

    this.wavePhase = 'calm'; // calm | warning | peak
    this.wavePhaseUntil = 0;
    this.nextWaveAt = Date.now() + 42_000;
  }

  reportNoise() {
    // В версии с Резонансом шум генераторов ускоряет приход следующей волны
    if (this.wavePhase === 'calm') {
      this.nextWaveAt = Math.min(this.nextWaveAt, Date.now() + 18_000);
    }
  }

  tick(now, players, tension, _closedDoors = [], onWaveHit = null) {
    if (players.length === 0) return;

    // 1. Управление «Волной Резонанса»
    if (this.wavePhase === 'calm' && now >= this.nextWaveAt) {
      this.wavePhase = 'warning';
      this.wavePhaseUntil = now + 9_000;
    } else if (this.wavePhase === 'warning' && now >= this.wavePhaseUntil) {
      this.wavePhase = 'peak';
      this.wavePhaseUntil = now + 5_000;
      // На пике проверяем тех, кто остался на свету и не спрятался
      for (const p of players) {
        const inHubSafe = Math.abs(p.x) < 4.5 && Math.abs(p.z) < 4.5;
        const safe = inHubSafe || p.hidden || (p.crouching && !p.flashlight);
        if (!safe) {
          p.composure = Math.max(12, p.composure - 38);
          if (onWaveHit) onWaveHit(p);
        }
      }
    } else if (this.wavePhase === 'peak' && now >= this.wavePhaseUntil) {
      this.wavePhase = 'calm';
      this.nextWaveAt = now + Math.max(34_000, 56_000 - tension * 16_000);
    }

    // 2. Управление тихим «Эхо-Двойником»
    if (this.active) {
      let minDist = Infinity;
      let nearest = null;
      for (const p of players) {
        const d = Math.hypot(p.x - this.x, p.z - this.z);
        if (d < minDist) { minDist = d; nearest = p; }
      }
      if (nearest) {
        this.yaw = Math.atan2(nearest.x - this.x, nearest.z - this.z);
      }
      if (minDist < 4.2 || now >= this.visibleUntil) {
        this.active = false;
        this.nextMimicAt = now + 20_000 + Math.random() * 16_000;
      }
      return;
    }

    if (now < this.nextMimicAt) return;

    const candidates = PATROL_WAYPOINTS.filter((pt) => {
      let minD = Infinity;
      for (const p of players) {
        const d = Math.hypot(p.x - pt.x, p.z - pt.z);
        if (d < minD) minD = d;
      }
      return minD >= 8.5 && minD <= 22.0;
    });

    if (candidates.length === 0) {
      this.nextMimicAt = now + 6_000;
      return;
    }

    const pt = candidates[Math.floor(Math.random() * candidates.length)];
    const randomPlayer = players[Math.floor(Math.random() * players.length)];
    this.active = true;
    this.x = pt.x;
    this.z = pt.z;
    this.mimicSkinId = randomPlayer?.skinId || 'medic';
    this.visibleUntil = now + 13_000;
  }

  serialize() {
    return {
      active: this.active,
      x: Number(this.x.toFixed(2)),
      z: Number(this.z.toFixed(2)),
      yaw: Number(this.yaw.toFixed(2)),
      mimicSkinId: this.mimicSkinId,
      wavePhase: this.wavePhase,
    };
  }
}

// === SERVER: GameRoom.js ===
/**
 * Авторитетная игровая комната и сессия (v1.2).
 * Добавлено: синхронизация двух турбин (relay_east_1 + relay_east_2) в окне 20 секунд при игре 2+ игроков.
 */


class GameRoom {
  constructor({ id, name, isPrivate, inviteCode, maxPlayers, hostPlayerId, tickRateHz = 15 }) {
    this.id = id;
    this.name = name;
    this.isPrivate = Boolean(isPrivate);
    this.inviteCode = inviteCode;
    this.maxPlayers = Math.max(2, Math.min(LIMITS.MAX_PLAYERS_CAP, maxPlayers || LIMITS.MAX_PLAYERS_DEFAULT));
    this.hostPlayerId = hostPlayerId;
    this.status = ROOM_STATUS.LOBBY;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.lastActivityAt = Date.now();

    this.players = new Map();
    this.objects = new Map();
    this.chatHistory = [];
    this.ownedKeycards = [];
    this.evacCode = '0000';
    this._turbineSyncTimer = null;

    this.eventEngine = new EventEngine(this);
    this.anomalyDirector = new AnomalyDirector();

    this._tickInterval = null;
    this._tickMs = Math.round(1000 / Math.max(5, Math.min(30, tickRateHz)));
    this._resetWorldState();
  }

  _resetWorldState() {
    clearTimeout(this._turbineSyncTimer);
    this._turbineSyncTimer = null;
    this.objects.clear();
    this.ownedKeycards = [];

    const digits = [
      crypto.randomInt(1, 10),
      crypto.randomInt(0, 10),
      crypto.randomInt(0, 10),
      crypto.randomInt(1, 10),
    ];
    this.evacCode = digits.join('');
    for (const obj of buildRandomizedMatchObjects(digits)) {
      this.objects.set(obj.id, obj);
    }

    this.eventEngine.reset();
    this.anomalyDirector.reset();
  }

  addPlayer(ws, { name, skinId, classId, customSkin } = {}) {
    if (this.players.size >= this.maxPlayers) {
      return { error: 'Комната уже заполнена.' };
    }
    if (this.status === ROOM_STATUS.PLAYING) {
      return { error: 'Игровая сессия уже идёт. Попросите хоста создать новое лобби или дождитесь завершения.' };
    }

    const id = 'p_' + crypto.randomBytes(5).toString('hex');
    const reconnectToken = crypto.randomBytes(12).toString('hex');
    const spawn = SPAWN_POINTS[this.players.size % SPAWN_POINTS.length];
    const cleanName = sanitizeText(name, LIMITS.MAX_NAME_LENGTH) || `Сотрудник-${this.players.size + 1}`;
    const skin = getSkinById(skinId);

    const player = {
      id,
      reconnectToken,
      ws,
      connected: true,
      disconnectedAt: null,
      name: cleanName,
      skinId: skin.id,
      classId: classId || "engineer",
      customSkin: customSkin || null,
      ready: false,
      x: spawn.x,
      y: 0,
      z: spawn.z,
      yaw: spawn.yaw,
      pitch: 0,
      speed: 0,
      flashlight: true,
      crouching: false,
      sprinting: false,
      composure: 100,
      animState: 'idle',
      lastStateAt: Date.now(),
      zoneName: getZoneAt(spawn.x, spawn.z).name,
    };

    this.players.set(id, player);
    if (!this.hostPlayerId || !this.players.has(this.hostPlayerId)) {
      this.hostPlayerId = id;
    }

    this.lastActivityAt = Date.now();
    this.broadcastLobbyState();
    this.broadcastSystemNotice(`${player.name} присоединился к комнате.`);
    return { player };
  }

  reconnectPlayer(ws, playerId, reconnectToken) {
    const player = this.players.get(playerId);
    if (!player || player.reconnectToken !== reconnectToken) {
      return { error: 'Сессия не найдена или истёк токен переподключения.' };
    }

    if (player.ws && player.ws !== ws && player.ws.readyState === 1) {
      player.ws.close(4000, 'Replaced by new connection');
    }

    player.ws = ws;
    player.connected = true;
    player.disconnectedAt = null;
    player.lastStateAt = Date.now();
    this.lastActivityAt = Date.now();

    this.broadcastSystemNotice(`${player.name} восстановил соединение.`);
    if (this.status === ROOM_STATUS.LOBBY) {
      this.broadcastLobbyState();
    } else if (this.status === ROOM_STATUS.PLAYING) {
      this.sendToPlayer(player.id, this._buildGameStartPacket());
    }
    return { player };
  }

  handleDisconnect(playerId, graceful = false) {
    const player = this.players.get(playerId);
    if (!player) return;

    if (graceful || this.status === ROOM_STATUS.LOBBY) {
      this.removePlayer(playerId, graceful ? 'покинул комнату' : 'отключился');
      return;
    }

    player.connected = false;
    player.ws = null;
    player.disconnectedAt = Date.now();
    this.broadcastSystemNotice(`${player.name} потерял связь. Ожидание переподключения (${Math.round(LIMITS.RECONNECT_GRACE_MS / 1000)} с)...`);
  }

  removePlayer(playerId, reasonText = 'покинул комнату') {
    const player = this.players.get(playerId);
    if (!player) return;

    this.players.delete(playerId);
    this.lastActivityAt = Date.now();

    if (this.hostPlayerId === playerId) {
      const next = this.getConnectedPlayers()[0] || [...this.players.values()][0] || null;
      this.hostPlayerId = next ? next.id : null;
      if (next) {
        this.broadcastSystemNotice(`Права хоста переданы игроку ${next.name}.`);
      }
    }

    this.broadcastSystemNotice(`${player.name} ${reasonText}.`);

    if (this.players.size === 0) {
      this.stopLoop();
      return;
    }

    if (this.status === ROOM_STATUS.LOBBY) {
      this.broadcastLobbyState();
    }
  }

  updatePlayerProfile(playerId, { name, skinId }) {
    const player = this.players.get(playerId);
    if (!player) return;
    if (name) {
      const clean = sanitizeText(name, LIMITS.MAX_NAME_LENGTH);
      if (clean) player.name = clean;
    }
    if (skinId) {
      player.skinId = getSkinById(skinId).id;
    }
    this.broadcastLobbyState();
  }

  setPlayerReady(playerId, ready) {
    const player = this.players.get(playerId);
    if (!player || this.status !== ROOM_STATUS.LOBBY) return;
    player.ready = Boolean(ready);
    this.broadcastLobbyState();
  }

  startGame(requesterId) {
    if (requesterId !== this.hostPlayerId) {
      return { error: 'Только хост комнаты может запустить экспедицию.' };
    }
    if (this.status !== ROOM_STATUS.LOBBY) {
      return { error: 'Игра уже запущена.' };
    }
    const connected = this.getConnectedPlayers();
    if (connected.length < LIMITS.MIN_PLAYERS_ONLINE) {
      return { error: 'Недостаточно подключённых игроков.' };
    }

    this._resetWorldState();
    this.status = ROOM_STATUS.PLAYING;
    this.startedAt = Date.now();
    this.lastActivityAt = Date.now();

    let idx = 0;
    for (const p of this.players.values()) {
      const sp = SPAWN_POINTS[idx % SPAWN_POINTS.length];
      p.x = sp.x;
      p.y = 0;
      p.z = sp.z;
      p.yaw = sp.yaw;
      p.pitch = 0;
      p.speed = 0;
      p.flashlight = true;
      p.crouching = false;
      p.sprinting = false;
      p.composure = 100;
      p.animState = 'idle';
      p.zoneName = getZoneAt(sp.x, sp.z).name;
      p.lastStateAt = Date.now();
      idx++;
    }

    this.broadcast(this._buildGameStartPacket());
    this.startLoop();
    return { ok: true };
  }

  returnToLobby(requesterId) {
    if (requesterId !== this.hostPlayerId) {
      return { error: 'Только хост может вернуть группу в лобби.' };
    }
    this.stopLoop();
    this.status = ROOM_STATUS.LOBBY;
    this.startedAt = null;
    for (const p of this.players.values()) {
      p.ready = false;
      p.composure = 100;
    }
    this.broadcastLobbyState();
    return { ok: true };
  }

  handlePlayerState(playerId, data) {
    if (this.status !== ROOM_STATUS.PLAYING) return;
    const p = this.players.get(playerId);
    if (!p || !p.connected) return;

    const now = Date.now();
    const dt = Math.max(0.016, Math.min(0.5, (now - p.lastStateAt) / 1000));
    p.lastStateAt = now;
    this.lastActivityAt = now;

    const reqX = Number(data.x);
    const reqZ = Number(data.z);
    if (Number.isFinite(reqX) && Number.isFinite(reqZ)) {
      const dx = reqX - p.x;
      const dz = reqZ - p.z;
      const dist = Math.hypot(dx, dz);
      const maxAllowed = LIMITS.MAX_MOVE_SPEED * dt + 0.65;

      let targetX = reqX;
      let targetZ = reqZ;
      if (dist > maxAllowed && dist > 0.001) {
        targetX = p.x + (dx / dist) * maxAllowed;
        targetZ = p.z + (dz / dist) * maxAllowed;
      }

      const closedDoors = this.getClosedDoors();
      const resolved = resolveMapCollision(targetX, targetZ, closedDoors, p.crouching, this.getSolidObjects());
      p.speed = Math.hypot(resolved.x - p.x, resolved.z - p.z) / dt;
      p.x = resolved.x;
      p.z = resolved.z;
      p.zoneName = getZoneAt(p.x, p.z).name;
    }

    if (Number.isFinite(Number(data.yaw))) p.yaw = Number(data.yaw);
    if (Number.isFinite(Number(data.pitch))) {
      p.pitch = Math.max(-1.35, Math.min(1.35, Number(data.pitch)));
    }
    if (typeof data.flashlight === 'boolean') p.flashlight = data.flashlight;
    if (typeof data.crouching === 'boolean') p.crouching = data.crouching;
    if (typeof data.sprinting === 'boolean') p.sprinting = data.sprinting;
    if (typeof data.hidden === 'boolean') {
      if (p.hidden && !data.hidden) {
        for (const o of this.objects.values()) {
          if (o.type === 'locker' && o.state.occupiedBy === playerId) o.state.occupiedBy = null;
        }
      }
      p.hidden = data.hidden;
    }
    if (typeof data.scared === 'boolean') p.scared = data.scared;
    if (typeof data.busy === 'boolean') p.busy = data.busy;
    if (data.holding === null || typeof data.holding === 'string') {
      p.holding = typeof data.holding === 'string' ? data.holding.slice(0, 16) : null;
    }

    if (p.speed > 0.35) {
      p.animState = p.crouching ? 'crouch_walk' : p.sprinting ? 'sprint' : 'walk';
    } else {
      p.animState = p.crouching ? 'crouch_idle' : 'idle';
    }
  }

  handleObjectInteract(playerId, objectId) {
    if (this.status !== ROOM_STATUS.PLAYING) return;
    const player = this.players.get(playerId);
    const obj = this.objects.get(objectId);
    if (!player || !obj) return;

    const dist = Math.hypot(player.x - obj.x, player.z - obj.z);
    if (dist > LIMITS.INTERACT_RANGE) {
      this.sendToPlayer(playerId, { type: MSG.ERROR, message: 'Вы слишком далеко от объекта.' });
      return;
    }

    if (obj.type === 'locker') {
      if (obj.state && obj.state.isTrap) {
        this.broadcastPlayerAction(playerId, 'locker_trap', obj.id);
        return;
      }
      if (obj.state.occupiedBy && obj.state.occupiedBy !== playerId) {
        this.sendToPlayer(playerId, { type: MSG.SYSTEM_NOTICE, text: 'Шкафчик уже занят напарником!' });
        return;
      }
      obj.state.occupiedBy = obj.state.occupiedBy === playerId ? null : playerId;
      this.broadcastPlayerAction(playerId, 'locker_door', obj.id);
      return;
    }

    const closedDoors = this.getClosedDoors();
    const losX = obj.x;
    const losZ = obj.type === 'loot_box' ? obj.z + (obj.rotY === 0 ? -0.82 : 0.82) : obj.z;
    if (!hasLineOfSight(player.x, player.z, losX, losZ, closedDoors, obj.type === 'door' ? obj.id : null)) {
      this.sendToPlayer(playerId, { type: MSG.ERROR, message: 'Между вами и объектом стена.' });
      return;
    }

    if (obj.type === 'loot_cabinet' || obj.type === 'loot_box') {
      if (obj.state.searched) return; // Повторно открыть/обыскать нельзя!
      obj.state.searched = true;
      this.broadcast({
        type: MSG.OBJECT_UPDATED,
        object: obj,
        actorId: playerId,
        lootItem: obj.state.lootItem || null,
      });
      this.broadcastPlayerAction(playerId, 'interact', obj.id);
      return;
    }

    if (obj.type === 'light_breaker') {
      if (obj.state.powerOn) return;
      obj.state.powerOn = true;
      this.broadcastObjectUpdate(obj, playerId);
      this.broadcastSystemNotice(`${player.name} восстановил освещение в Серверной!`);
      return;
    }

    if (obj.type === 'sec_terminal') {
      const now = Date.now();
      if (now < (obj.state.cooldownUntil || 0)) return;
      obj.state.cooldownUntil = now + 90_000;
      const shieldUntil = now + 45_000;
      if (this.anomalyDirector) {
        this.anomalyDirector.nextWaveAt = Math.max(this.anomalyDirector.nextWaveAt || 0, shieldUntil);
      }
      this.broadcast({ type: MSG.OBJECT_UPDATED, object: obj, actorId: playerId, waveShieldUntil: shieldUntil });
      this.broadcastSystemNotice(`${player.name} включил щит в Охране — Волны не будет 45с!`);
      return;
    }

    if (obj.type === 'srv_scanner') {
      const now = Date.now();
      if (now < (obj.state.cooldownUntil || 0)) return;
      obj.state.cooldownUntil = now + 60_000;
      const candidates = [...this.objects.values()].filter((o) => (o.type === 'relay' && !o.state.active) || (o.type === 'note' && !o.state.read) || (o.type === 'keycard' && !o.state.pickedUp));
      const targetObj = candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : null;
      const zoneHint = targetObj ? getZoneAt(targetObj.x, targetObj.z).name : 'Шлюз Альфа';
      const scanTarget = targetObj ? { x: targetObj.x, z: targetObj.z, label: targetObj.type === 'relay' ? 'ГЕНЕРАТОР' : targetObj.type === 'note' ? 'КОД' : 'КАРТА' } : null;
      this.broadcast({ type: MSG.OBJECT_UPDATED, object: obj, actorId: playerId, scanOrigin: { x: obj.x, z: obj.z }, scanTarget });
      this.broadcastSystemNotice(`Сканер Серверной: ${scanTarget ? scanTarget.label : 'цель'} в секторе «${zoneHint}»!`);
      return;
    }

    if (obj.type === 'pump_valve') {
      if (obj.state.closed) return;
      obj.state.closed = true;
      this.broadcastObjectUpdate(obj, playerId);
      this.broadcastSystemNotice(`${player.name} перекрыл паровой вентиль в Насосной.`);
      return;
    }

    this.lastActivityAt = Date.now();

    if (obj.type === 'keycard') {
      if (obj.state.pickedUp) return;
      obj.state.pickedUp = true;
      const cardName = obj.state.cardName || obj.label;
      if (!this.ownedKeycards.some((c) => c.id === obj.id)) {
        this.ownedKeycards.push({ id: obj.id, name: cardName });
      }
      for (const did of obj.state.unlocksDoors || []) {
        const d = this.objects.get(did);
        if (d) {
          d.state.locked = false;
          d.label = d.label.replace(/\s*\([^)]*\)/, '');
          this.broadcast({ type: MSG.OBJECT_UPDATED, object: d, byPlayerId: playerId });
        }
      }
      this.broadcast({ type: MSG.OBJECT_UPDATED, object: obj, byPlayerId: playerId });
      this.broadcastSystemNotice(`${player.name} нашёл: ${cardName}.`);
      return;
    }

    if (obj.type === 'door') {
      if (obj.state.locked) {
        if (obj.state.requiredKeycardName) {
          this.sendToPlayer(playerId, {
            type: MSG.SYSTEM_NOTICE,
            text: 'Дверь заблокирована. Найдите ключ-карту в Западной лаборатории или Генераторном блоке.',
          });
          return;
        }
        const needed = obj.state.requiresRelays || MAP_CONFIG.requiredRelays;
        const current = this.getActivatedRelayCount();
        this.sendToPlayer(playerId, {
          type: MSG.SYSTEM_NOTICE,
          text: `Шлюз заблокирован. Активировано реле: ${current}/${needed}.`,
        });
        return;
      }
      obj.state.isOpen = !obj.state.isOpen;
      this.broadcastObjectUpdate(obj, player.id);
      this.broadcastPlayerAction(player.id, 'interact', obj.id);
      return;
    }

    if (obj.type === 'relay') {
      if (obj.state.active) return;
      obj.state.active = true;
      this.broadcastObjectUpdate(obj, player.id);
      this.broadcastPlayerAction(player.id, 'interact', obj.id);

      // Кооперативная синхронизация Турбины А и Турбины Б при игре 2+ человек (20 секунд)
      const isCoop = this.getConnectedPlayers().length >= 2;
      if (isCoop && (obj.id === 'relay_east_1' || obj.id === 'relay_east_2')) {
        const pairId = obj.id === 'relay_east_1' ? 'relay_east_2' : 'relay_east_1';
        const pair = this.objects.get(pairId);
        if (pair && !pair.state.active) {
          clearTimeout(this._turbineSyncTimer);
          this.broadcastSystemNotice(
            `⚡ ${obj.label} запущена! Включите ${pair.label} в течение 20 секунд, иначе защита сбросит ток!`,
          );
          this._turbineSyncTimer = setTimeout(() => {
            if (this.status !== ROOM_STATUS.PLAYING) return;
            if (!pair.state.active && obj.state.active) {
              obj.state.active = false;
              this.broadcastObjectUpdate(obj, null);
              this.broadcast({
                type: MSG.HORROR_EVENT,
                eventId: 'turbine_sync_fail',
                scope: 'global',
                timestamp: Date.now(),
                payload: {
                  effect: 'power_flicker',
                  durationMs: 3200,
                  sound: 'power_drop',
                  subtitle: `Синхронизация турбин сорвалась — ${obj.label} отключилась! Запустите обе почти одновременно.`,
                },
              });
            }
          }, 20_000);
          this._turbineSyncTimer.unref?.();
        } else if (pair && pair.state.active) {
          clearTimeout(this._turbineSyncTimer);
          this._turbineSyncTimer = null;
          this.broadcastSystemNotice('⚡ Обе турбины синхронизированы и зафиксированы!');
        }
      }

      const relayCount = this.getActivatedRelayCount();
      if (relayCount >= MAP_CONFIG.requiredRelays) {
        const airlock = this.objects.get('door_airlock');
        if (airlock && airlock.state.locked) {
          airlock.state.locked = false;
          airlock.state.isOpen = true;
          this.broadcastObjectUpdate(airlock, player.id);
        }
      }

      this.eventEngine.triggerAction('relay_activated', {
        relayCount,
        requiredRelays: MAP_CONFIG.requiredRelays,
        actorName: player.name,
      });
      return;
    }

    if (obj.type === 'note') {
      obj.state.read = true;
      if (typeof obj.state.codeIndex === 'number' && obj.state.codeDigit !== undefined) {
        this.broadcast({ type: MSG.OBJECT_UPDATED, object: obj, actorId: playerId, sharedNoteDigit: { pos: obj.state.codeIndex + 1, digit: String(obj.state.codeDigit) } });
      }
      this.broadcastPlayerAction(player.id, 'read_note', obj.id);
      this.sendToPlayer(playerId, {
        type: MSG.OBJECT_UPDATED,
        object: obj,
        openedNote: obj.state,
      });
      return;
    }

    if (obj.type === 'evac_terminal') {
      if (this.getActivatedRelayCount() < MAP_CONFIG.requiredRelays) {
        this.sendToPlayer(playerId, {
          type: MSG.SYSTEM_NOTICE,
          text: 'Недостаточно питания для запуска подъёмника (нужны все 7 генераторов).',
        });
        return;
      }
      this.sendToPlayer(playerId, {
        type: MSG.OPEN_KEYPAD,
        prompt: 'Введите 4-значный код эвакуации (цифры из 4 журналов станции):',
      });
    }
  }

  handleSubmitCode(playerId, codeRaw) {
    if (this.status !== ROOM_STATUS.PLAYING) return;
    const player = this.players.get(playerId);
    const term = this.objects.get('evac_terminal');
    if (!player || !term) return;

    const dist = Math.hypot(player.x - term.x, player.z - term.z);
    if (dist > LIMITS.INTERACT_RANGE + 1.0) return;

    if (this.getActivatedRelayCount() < MAP_CONFIG.requiredRelays) {
      this.sendToPlayer(playerId, { type: MSG.ERROR, message: 'Сначала запустите все 7 генераторов.' });
      return;
    }

    const cleanCode = String(codeRaw || '').replace(/\D/g, '').slice(0, 4);
    if (cleanCode === this.evacCode) {
      term.state.activated = true;
      this.broadcastObjectUpdate(term, player.id);
      this.endSession(
        'evacuated',
        `Код ${this.evacCode} принят! Группа под руководством ${player.name} запустила аварийный подъёмник и покинула «Объект-9».`,
      );
    } else {
      this.broadcast({
        type: MSG.HORROR_EVENT,
        eventId: 'wrong_evac_code',
        scope: 'global',
        timestamp: Date.now(),
        payload: {
          effect: 'emergency_red',
          durationMs: 4500,
          sound: 'klaxon_distant',
          subtitle: `Неверный код (${cleanCode || '----'})! Сработала тревога шлюза.`,
        },
      });
    }
  }

  handlePlayerInteract(actorId, targetPlayerId, action = 'steady') {
    if (this.status !== ROOM_STATUS.PLAYING) return;
    const actor = this.players.get(actorId);
    const target = this.players.get(targetPlayerId);
    if (!actor || !target || actor.id === target.id) return;


    if (target.downed && !target.carriedBy && !actor.carryingPlayerId) {
      actor.carryingPlayerId = target.id;
      target.carriedBy = actor.id;
      target.reviveEndAt = 0;
      this.broadcastSystemNotice(`${actor.name} поднял ${target.name} на руки! Несите в Медотсек.`);
      return;
    }    const dist = Math.hypot(actor.x - target.x, actor.z - target.z);
    if (dist > LIMITS.PLAYER_INTERACT_RANGE) return;
    if (!hasLineOfSight(actor.x, actor.z, target.x, target.z, this.getClosedDoors())) return;

    if (action === 'steady') {
      target.composure = Math.min(100, target.composure + 34);
      actor.composure = Math.min(100, actor.composure + 12);
      this.broadcastPlayerAction(actor.id, 'steady', target.id);
      this.broadcastSystemNotice(`${actor.name} поддержал ${target.name} — паника отступила.`);
    }
  }

  handleRadioPing(playerId) {
    if (this.status !== ROOM_STATUS.PLAYING) return;
    const player = this.players.get(playerId);
    if (!player) return;

    this.broadcast({
      type: MSG.RADIO_SIGNAL,
      playerId: player.id,
      playerName: player.name,
      x: Number(player.x.toFixed(2)),
      z: Number(player.z.toFixed(2)),
      zoneName: player.zoneName,
      timestamp: Date.now(),
    });
  }

  handleChat(playerId, text) {
    const player = this.players.get(playerId);
    if (!player) return;
    const clean = sanitizeText(text, LIMITS.MAX_CHAT_LENGTH);
    if (!clean) return;

    const msg = {
      type: MSG.CHAT_MESSAGE,
      id: crypto.randomBytes(4).toString('hex'),
      senderId: player.id,
      senderName: player.name,
      skinId: player.skinId,
      text: clean,
      timestamp: Date.now(),
    };
    this.chatHistory.push(msg);
    if (this.chatHistory.length > 40) this.chatHistory.shift();
    this.broadcast(msg);
  }

  endSession(outcome, summary) {
    this.stopLoop();
    this.status = ROOM_STATUS.ENDED;
    const durationSec = Math.round(this.getElapsedSeconds());
    this.broadcast({
      type: MSG.SESSION_ENDED,
      outcome,
      summary,
      durationSec,
      relaysActivated: this.getActivatedRelayCount(),
      hostPlayerId: this.hostPlayerId,
    });
  }

  startLoop() {
    this.stopLoop();
    this._tickInterval = setInterval(() => this._tick(), this._tickMs);
  }

  stopLoop() {
    clearTimeout(this._turbineSyncTimer);
    this._turbineSyncTimer = null;
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
  }

  _tick() {
    const now = Date.now();

    for (const [id, p] of this.players.entries()) {
      if (!p.connected && p.disconnectedAt && now - p.disconnectedAt > LIMITS.RECONNECT_GRACE_MS) {
        this.removePlayer(id, 'не смог переподключиться');
      }
    }

    if (this.status !== ROOM_STATUS.PLAYING) return;

    const connected = this.getConnectedPlayers();
    let sprintNoise = 0;
    for (const p of connected) {
      if (p.sprinting && p.speed > 3.5) sprintNoise += 0.08;
      let nearMate = false;
      for (const other of connected) {
        if (other.id !== p.id && Math.hypot(p.x - other.x, p.z - other.z) < 7.5) {
          nearMate = true;
          break;
        }
      }
      if (nearMate && p.composure < 100) {
        p.composure = Math.min(100, p.composure + 0.14);
      }
    }

    // Автоматическая реанимация на койке Медотсека (напарнику стоять рядом не нужно!)
    for (const p of connected) {
      if (p.downed && p.reviveEndAt && now >= p.reviveEndAt) {
        p.downed = false;
        p.carriedBy = null;
        p.reviveEndAt = 0;
        p.composure = 70;
        this.broadcastSystemNotice(`${p.name} пришёл в себя на койке Медотсека!`);
      }
      if (p.carryingPlayerId) {
        const carried = this.players.get(p.carryingPlayerId);
        if (!carried || !carried.connected || !carried.downed) {
          p.carryingPlayerId = null;
        } else {
          carried.x = p.x; carried.z = p.z;
          // Если донесли до Медотсека (x > 33) — автоматически укладываем на койку и запускаем таймер!
          if (p.x > 33.0 && Math.abs(p.z) < 11.0) {
            const reviveSec = p.classId === 'medic' ? 15 : 30;
            carried.carriedBy = null;
            carried.x = 39.6; carried.z = 0.0;
            carried.reviveEndAt = now + reviveSec * 1000;
            p.carryingPlayerId = null;
            this.broadcastSystemNotice(`${p.name} положил ${carried.name} на койку Медотсека — реанимация ${reviveSec}с!`);
          }
        }
      }
    }
    this.eventEngine.tick(now, this.getElapsedSeconds());
    this.anomalyDirector.tick(now, connected, Math.min(1, this.eventEngine.tension + sprintNoise), this.getClosedDoors(), (caught) => {
      caught.x = 0; caught.z = 2.2; caught.composure = 20;
      this.broadcastSystemNotice(`${caught.name} попал под волну резонанса и отброшен в Центральный узел!`);
    });

    this.broadcast({
      type: MSG.WORLD_SNAPSHOT,
      serverTime: now,
      tension: Number(this.eventEngine.tension.toFixed(2)),
      relaysActivated: this.getActivatedRelayCount(),
      ownedKeycards: this.ownedKeycards,
      anomaly: this.anomalyDirector.serialize(),
      players: connected.map((p) => ({
        id: p.id,
        name: p.name,
        skinId: p.skinId,
        x: Number(p.x.toFixed(3)),
        z: Number(p.z.toFixed(3)),
        yaw: Number(p.yaw.toFixed(3)),
        pitch: Number(p.pitch.toFixed(3)),
        flashlight: p.flashlight,
        crouching: p.crouching,
        sprinting: Boolean(p.sprinting),
        hidden: Boolean(p.hidden),
        downed: Boolean(p.downed),
        carryingPlayerId: p.carryingPlayerId || null,
        carriedBy: p.carriedBy || null,
        reviveLeftSec: p.reviveEndAt ? Math.max(0, Math.ceil((p.reviveEndAt - now) / 1000)) : 0,
        scared: Boolean(p.scared),
        holding: p.holding || null,
        customSkin: p.customSkin || null,
        classId: p.classId || 'engineer',
        animState: p.animState,
        composure: Math.round(p.composure),
        zoneName: p.zoneName,
      })),
    });
  }

  getConnectedPlayers() {
    return [...this.players.values()].filter((p) => p.connected && p.ws && p.ws.readyState === 1);
  }

  getClosedDoors() {
    const list = [];
    for (const obj of this.objects.values()) {
      if (obj.type === 'door' && !obj.state.isOpen) {
        list.push(obj);
      }
    }
    return list;
  }

  getActivatedRelayCount() {
    let count = 0;
    for (const obj of this.objects.values()) {
      if (obj.type === 'relay' && obj.state.active) count++;
    }
    return count;
  }

  getElapsedSeconds() {
    return this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0;
  }

  _buildGameStartPacket() {
    return {
      type: MSG.GAME_STARTED,
      roomId: this.id,
      hostPlayerId: this.hostPlayerId,
      ownedKeycards: this.ownedKeycards,
      objects: [...this.objects.values()],
      players: this.getConnectedPlayers().map((p) => ({
        id: p.id,
        name: p.name,
        skinId: p.skinId,
        x: p.x,
        z: p.z,
        yaw: p.yaw,
        pitch: p.pitch,
        flashlight: p.flashlight,
        composure: Math.round(p.composure),
        animState: p.animState,
      })),
    };
  }

  broadcastLobbyState() {
    this.broadcast({
      type: MSG.LOBBY_STATE,
      room: this.getPublicSummary(true),
      hostPlayerId: this.hostPlayerId,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        skinId: p.skinId,
        ready: p.ready,
        connected: p.connected,
        isHost: p.id === this.hostPlayerId,
      })),
    });
  }

  broadcastObjectUpdate(obj, actorId = null) {
    this.broadcast({
      type: MSG.OBJECT_UPDATED,
      object: obj,
      actorId,
    });
  }

  broadcastPlayerAction(playerId, action, targetId = null) {
    this.broadcast({
      type: MSG.PLAYER_ACTION,
      playerId,
      action,
      targetId,
      timestamp: Date.now(),
    });
  }

  broadcastSystemNotice(text) {
    this.broadcast({
      type: MSG.SYSTEM_NOTICE,
      text,
      timestamp: Date.now(),
    });
  }

  sendToPlayer(playerId, payload) {
    const p = this.players.get(playerId);
    if (p && p.connected && p.ws && p.ws.readyState === 1) {
      p.ws.sendJSON(payload);
    }
  }

  broadcast(payload) {
    const raw = JSON.stringify(payload);
    for (const p of this.players.values()) {
      if (p.connected && p.ws && p.ws.readyState === 1) {
        p.ws.send(raw);
      }
    }
  }

  getPublicSummary(includeCode = false) {
    return {
      id: this.id,
      name: this.name,
      isPrivate: this.isPrivate,
      inviteCode: includeCode || !this.isPrivate ? this.inviteCode : undefined,
      status: this.status,
      playerCount: this.players.size,
      maxPlayers: this.maxPlayers,
    };
  }
}

function sanitizeText(str, maxLen) {
  if (typeof str !== 'string') return '';
  return str.replace(/[\r\n\t<>]/g, ' ').trim().slice(0, maxLen);
}

// === SERVER: RoomManager.js ===
/**
 * Менеджер игровых комнат: создание публичных и приватных комнат,
 * генерация 6-символьных кодов приглашения, список комнат и очистка пустых.
 */


const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class RoomManager {
  constructor({ maxRooms = 50, tickRateHz = 15, idleCleanupMs = 120_000 } = {}) {
    this.maxRooms = maxRooms;
    this.tickRateHz = tickRateHz;
    this.rooms = new Map(); // roomId -> GameRoom
    this.codeToRoomId = new Map(); // inviteCode -> roomId

    this._cleanupTimer = setInterval(() => this._cleanupEmptyRooms(idleCleanupMs), 30_000);
    this._cleanupTimer.unref?.();
  }

  createRoom({ name, isPrivate, maxPlayers }) {
    if (this.rooms.size >= this.maxRooms) {
      return { error: 'На сервере достигнут лимит активных комнат. Попробуйте позже.' };
    }

    const id = 'r_' + crypto.randomBytes(4).toString('hex');
    const inviteCode = this._generateUniqueCode();
    const cleanName =
      typeof name === 'string' && name.trim()
        ? name.replace(/[\r\n\t<>]/g, ' ').trim().slice(0, LIMITS.MAX_ROOM_NAME_LENGTH)
        : `Сектор #${inviteCode.slice(0, 3)}`;

    const room = new GameRoom({
      id,
      name: cleanName,
      isPrivate: Boolean(isPrivate),
      inviteCode,
      maxPlayers,
      hostPlayerId: null,
      tickRateHz: this.tickRateHz,
    });

    this.rooms.set(id, room);
    this.codeToRoomId.set(inviteCode, id);
    return { room };
  }

  getRoomById(roomId) {
    return this.rooms.get(roomId) || null;
  }

  getRoomByCode(code) {
    if (typeof code !== 'string') return null;
    const normalized = code.trim().toUpperCase();
    const roomId = this.codeToRoomId.get(normalized);
    return roomId ? this.rooms.get(roomId) || null : null;
  }

  listPublicRooms() {
    const result = [];
    for (const room of this.rooms.values()) {
      if (!room.isPrivate && room.players.size > 0 && room.status !== ROOM_STATUS.ENDED) {
        result.push(room.getPublicSummary(false));
      }
    }
    return result;
  }

  deleteRoomIfEmpty(room) {
    if (!room || room.players.size > 0) return;
    room.stopLoop();
    this.rooms.delete(room.id);
    this.codeToRoomId.delete(room.inviteCode);
  }

  _cleanupEmptyRooms(idleCleanupMs) {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (room.players.size === 0 || (room.getConnectedPlayers().length === 0 && now - room.lastActivityAt > idleCleanupMs)) {
        room.stopLoop();
        this.rooms.delete(room.id);
        this.codeToRoomId.delete(room.inviteCode);
      }
    }
  }

  _generateUniqueCode() {
    for (let attempt = 0; attempt < 20; attempt++) {
      let code = '';
      for (let i = 0; i < 6; i++) {
        code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
      }
      if (!this.codeToRoomId.has(code)) return code;
    }
    return crypto.randomBytes(3).toString('hex').toUpperCase();
  }

  shutdown() {
    clearInterval(this._cleanupTimer);
    for (const room of this.rooms.values()) {
      room.stopLoop();
    }
    this.rooms.clear();
    this.codeToRoomId.clear();
  }
}

// === SERVER: index.js ===
/**
 * Точка входа сервера «ЭХО СТАНЦИИ: ОБЪЕКТ-9».
 */



const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = __dirname;
const CLIENT_DIR = __dirname;
const SHARED_DIR = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function createGameServer(customConfig = {}) {
  const cfg = { ...SERVER_CONFIG, ...customConfig };
  const roomManager = new RoomManager({
    maxRooms: cfg.maxRooms,
    tickRateHz: cfg.tickRateHz,
    idleCleanupMs: cfg.roomIdleCleanupMs,
  });

  const httpServer = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(reqUrl.pathname);

    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          status: 'ok',
          protocol: PROTOCOL_VERSION,
          rooms: roomManager.rooms.size,
          uptimeSec: Math.round(process.uptime()),
        }),
      );
      return;
    }

    let targetPath;
    if (pathname.startsWith('/shared/')) {
      const rel = pathname.slice('/shared/'.length);
      targetPath = path.resolve(SHARED_DIR, rel);
      if (!targetPath.startsWith(SHARED_DIR)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
    } else {
      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      targetPath = path.resolve(CLIENT_DIR, rel);
      if (!targetPath.startsWith(CLIENT_DIR)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
    }

    fs.readFile(targetPath, (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      const ext = path.extname(targetPath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(content);
    });
  });

  const wss = new WebSocketServer(httpServer, {
    heartbeatIntervalMs: cfg.heartbeatIntervalMs,
  });

  wss.on('connection', (ws) => {
    const session = {
      room: null,
      playerId: null,
    };

    ws.sendJSON({
      type: MSG.WELCOME,
      protocol: PROTOCOL_VERSION,
      serverTime: Date.now(),
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        ws.sendJSON({ type: MSG.ERROR, message: 'Некорректный формат сетевого пакета.' });
        return;
      }

      if (!msg || typeof msg.type !== 'string') return;
      routeMessage(ws, session, msg, roomManager);
    });

    ws.on('close', () => {
      if (session.room && session.playerId) {
        session.room.handleDisconnect(session.playerId, false);
        roomManager.deleteRoomIfEmpty(session.room);
      }
    });
  });

  return {
    httpServer,
    wss,
    roomManager,
    start() {
      return new Promise((resolve) => {
        httpServer.listen(cfg.port, cfg.host, () => {
          const addr = httpServer.address();
          resolve(addr);
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        wss.close();
        roomManager.shutdown();
        httpServer.close(() => resolve());
      });
    },
  };
}

function routeMessage(ws, session, msg, roomManager) {
  switch (msg.type) {
    case MSG.PING: {
      ws.sendJSON({ type: MSG.PONG, clientTime: msg.clientTime || 0, serverTime: Date.now() });
      return;
    }

    case MSG.LIST_ROOMS: {
      ws.sendJSON({ type: MSG.ROOM_LIST, rooms: roomManager.listPublicRooms() });
      return;
    }

    case MSG.CREATE_ROOM: {
      leaveCurrentRoom(session, roomManager, true);
      const { room, error } = roomManager.createRoom({
        name: msg.roomName,
        isPrivate: msg.isPrivate,
        maxPlayers: msg.maxPlayers,
      });
      if (error) {
        ws.sendJSON({ type: MSG.ERROR, message: error });
        return;
      }
      joinRoomInternal(ws, session, room, { name: msg.playerName, skinId: msg.skinId });
      return;
    }

    case MSG.JOIN_ROOM: {
      const room = roomManager.getRoomById(msg.roomId);
      if (!room) {
        ws.sendJSON({ type: MSG.ERROR, message: 'Комната не найдена или уже закрыта.' });
        return;
      }
      leaveCurrentRoom(session, roomManager, true);
      joinRoomInternal(ws, session, room, { name: msg.playerName, skinId: msg.skinId });
      return;
    }

    case MSG.JOIN_BY_CODE: {
      const room = roomManager.getRoomByCode(msg.inviteCode);
      if (!room) {
        ws.sendJSON({ type: MSG.ERROR, message: 'Комната с таким кодом приглашения не найдена.' });
        return;
      }
      leaveCurrentRoom(session, roomManager, true);
      joinRoomInternal(ws, session, room, { name: msg.playerName, skinId: msg.skinId });
      return;
    }

    case MSG.RECONNECT: {
      const room = roomManager.getRoomById(msg.roomId);
      if (!room) {
        ws.sendJSON({ type: MSG.ERROR, code: 'RECONNECT_FAILED', message: 'Комната больше не существует.' });
        return;
      }
      const { player, error } = room.reconnectPlayer(ws, msg.playerId, msg.reconnectToken);
      if (error) {
        ws.sendJSON({ type: MSG.ERROR, code: 'RECONNECT_FAILED', message: error });
        return;
      }
      session.room = room;
      session.playerId = player.id;
      ws.sendJSON({
        type: MSG.ROOM_JOINED,
        room: room.getPublicSummary(true),
        playerId: player.id,
        reconnectToken: player.reconnectToken,
        reconnected: true,
      });
      return;
    }

    case MSG.LEAVE_ROOM: {
      leaveCurrentRoom(session, roomManager, true);
      ws.sendJSON({ type: MSG.ROOM_LEFT });
      return;
    }

    case MSG.SET_READY: {
      if (session.room && session.playerId) {
        session.room.setPlayerReady(session.playerId, msg.ready);
      }
      return;
    }

    case MSG.UPDATE_PROFILE: {
      if (session.room && session.playerId) {
        session.room.updatePlayerProfile(session.playerId, { name: msg.name, skinId: msg.skinId });
      }
      return;
    }

    case MSG.START_GAME: {
      if (!session.room || !session.playerId) return;
      const res = session.room.startGame(session.playerId);
      if (res.error) ws.sendJSON({ type: MSG.ERROR, message: res.error });
      return;
    }

    case MSG.RETURN_LOBBY: {
      if (!session.room || !session.playerId) return;
      const res = session.room.returnToLobby(session.playerId);
      if (res.error) ws.sendJSON({ type: MSG.ERROR, message: res.error });
      return;
    }

    case MSG.PLAYER_STATE: {
      if (session.room && session.playerId) {
        session.room.handlePlayerState(session.playerId, msg);
      }
      return;
    }

    case MSG.INTERACT_OBJECT: {
      if (session.room && session.playerId) {
        session.room.handleObjectInteract(session.playerId, msg.objectId);
      }
      return;
    }

    case MSG.INTERACT_PLAYER: {
      if (session.room && session.playerId) {
        session.room.handlePlayerInteract(session.playerId, msg.targetPlayerId, msg.action);
      }
      return;
    }

    case MSG.SUBMIT_CODE: {
      if (session.room && session.playerId) {
        session.room.handleSubmitCode(session.playerId, msg.code);
      }
      return;
    }

    case MSG.RADIO_PING: {
      if (session.room && session.playerId) {
        session.room.handleRadioPing(session.playerId);
      }
      return;
    }

    case MSG.CHAT_SEND: {
      if (session.room && session.playerId) {
        session.room.handleChat(session.playerId, msg.text);
      }
      return;
    }

    default:
      break;
  }
}

function joinRoomInternal(ws, session, room, profile) {
  const { player, error } = room.addPlayer(ws, profile);
  if (error) {
    ws.sendJSON({ type: MSG.ERROR, message: error });
    return;
  }
  session.room = room;
  session.playerId = player.id;
  ws.sendJSON({
    type: MSG.ROOM_JOINED,
    room: room.getPublicSummary(true),
    playerId: player.id,
    reconnectToken: player.reconnectToken,
    reconnected: false,
  });
  room.broadcastLobbyState();
}

function leaveCurrentRoom(session, roomManager, graceful) {
  if (!session.room || !session.playerId) return;
  const oldRoom = session.room;
  const oldPlayerId = session.playerId;
  session.room = null;
  session.playerId = null;
  oldRoom.handleDisconnect(oldPlayerId, graceful);
  roomManager.deleteRoomIfEmpty(oldRoom);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  const server = createGameServer();
  server.start().then((addr) => {
    console.log(`[ЭХО СТАНЦИИ: ОБЪЕКТ-9] Сервер запущен: http://${SERVER_CONFIG.host}:${addr.port}`);
  });
}
