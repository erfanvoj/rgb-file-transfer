# RGB Optical Air-Gap File Transfer

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-5.x-646CFF?style=flat-square&logo=vite)](https://vitejs.dev/)

An experimental browser-based system for transmitting arbitrary binary payloads across air-gapped devices using screen-to-camera color modulation. Operates entirely over optical channels without Wi-Fi, Bluetooth, WebRTC, local network connectivity, or external servers.

---

## Technical Overview

The application serializes files into rateless fountain codes (Luby Transform) and modulates them into animated 2D color matrices rendered on an HTML5 canvas. A receiving device captures the optical stream through its camera, detects corner anchors to perform perspective homography rectification in a Web Worker, samples per-channel color thresholds from an on-frame calibration strip, and reconstructs the original file byte-for-byte.

```
Transmitter (Sender)
[ File Bytes ] ──> [ LT Fountain Encoder ] ──> [ 96B Wire Frames ] ──> [ Canvas Matrix ]
                                                                             │
                                                                       (Optical Link)
                                                                             │
Receiver                                                                     ▼
[ Reassembled File ] ◄── [ Peeling Solver ] ◄── [ Homography & CV ] ◄── [ Camera Feed ]
```

---

## Operating Envelope & Performance Characteristics

| Parameter | Nominal Range | Engineering Considerations |
|---|---|---|
| **Effective Throughput** | 15 – 30 KB/s | Dependent on matrix density ($16\times16$), frame hold duration ($160\text{ms}$ / ~6.25 FPS), and decode efficiency |
| **Optimal Distance** | 15 – 25 cm (6 – 10 in) | Frame must occupy at least 40% of camera FOV for reliable anchor isolation |
| **Angular Tolerance** | Up to $\pm25^\circ$ off-axis | Planar homography compensates for perspective tilt and hand tremor |
| **Lighting Environment** | 150 – 800 lux (diffuse) | Avoid direct sunlight glare or high-frequency LED PWM strobing on the display |
| **Display Panel** | IPS, OLED, VA | Per-frame dynamic calibration compensates for display gamma curves and viewing-angle color shifts |

---

## Key Subsystems

### 1. Rateless Erasure Coding (Luby Transform)
Because optical channels are strictly unidirectional (simplex communication without ACK/NACK feedback), packet loss caused by dropped camera frames or occlusion would stall sequential transfers. The encoder uses a deterministic **Mulberry32 PRNG** combined with the **Robust Soliton Distribution** to emit an unbounded stream of encoded droplets. The receiver uses a bit-parallel Gaussian elimination peeling solver in $\text{GF}(2)$ to resolve original source blocks regardless of packet arrival order.

### 2. Corner Anchor Detection & Homography Rectification
The display renders four corner markers: one unique **Magenta (`#FF00FF`)** marker at Top-Left and three **Cyan (`#00FFFF`)** markers at Top-Right, Bottom-Right, and Bottom-Left. The receiver identifies candidates via channel-difference peak detection, validates quad convexity and clockwise ordering, and solves an $8\times8$ linear system to obtain a $3\times3$ projective homography matrix mapping the camera quad to a normalized $320\times320\text{px}$ buffer.

### 3. Dynamic Calibration Strip
Screen color reproduction and camera auto-white-balance (AWB) vary widely across devices. A top-edge calibration strip containing all 8 palette colors is sampled on every frame to establish dynamic per-channel midpoints ($T_R, T_G, T_B$). Data cells are classified by independent 3-channel binary thresholding ($2^3 = 8\text{ states}$) rather than brittle Euclidean distance in RGB space.

### 4. Rolling-Shutter Visual Clock Gating
CMOS rolling-shutter sensors expose pixel rows progressively, which causes frame tearing when screen frames change mid-exposure. A dedicated 2-state visual clock toggles between pure black and pure white. Frames with intermediate clock luminance ($0.25 < L < 0.75$) or identical consecutive states are discarded prior to matrix demodulation.

### 5. Web Worker CV Pipeline
All image processing, matrix warping, and pixel sampling execute inside a dedicated Web Worker. Frame transfers from the main thread utilize zero-copy `ArrayBuffer` transfer semantics to eliminate memory duplication and maintain smooth 60 FPS UI rendering.

---

## Wire Format

Each optical transmission frame is structured into a fixed 96-byte packet:

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|       Magic (0xABCD)          |    File ID    |  Seed / Seq   |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
| (Seed / Seq)  |  Total Chunks (K)             |  CRC-16 CCITT |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
| (CRC-16 cont) |           Payload Data (87 Bytes)             |
|               ...                                             |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

- **Magic (`0xABCD`)**: 2-byte frame boundary delimiter.
- **File ID**: 1-byte session identifier to isolate concurrent streams.
- **Seed / Seq**: 2-byte PRNG seed used to generate chunk degree and combination indices.
- **Total Chunks ($K$)**: 2-byte count of source chunks for the file.
- **CRC-16-CCITT**: 2-byte checksum computed over header and payload with CRC field zeroed.
- **Payload**: 87 bytes of XOR-combined source chunk data.

---

## Project Structure

```
src/
├── config.ts              # Matrix geometry, timings, and palette constants
├── main.ts                # UI coordinator, camera lifecycle, and worker orchestration
├── protocol/
│   ├── chunker.ts         # File slicing, CRC16, and color quantization helpers
│   └── fountain.ts        # PRNG, Soliton distribution, and degree sampling
├── receiver/
│   ├── anchorDetector.ts  # Peak detection, quad ordering, and homography solver
│   ├── reassembler.ts     # Peeling decoder and linear solver in GF(2)
│   └── worker.ts          # Off-thread computer vision pipeline
├── sender/
│   └── canvasRenderer.ts  # Canvas matrix, anchor, and clock renderer
└── style.css              # Application layout and HUD styling
```

---

## Development

```bash
# Install dependencies
npm install

# Start local dev server
npm run dev

# Run fountain code simulation suite
npx tsx tests/fountain_sim.ts

# Production build and type check
npm run build
```

> **Requirements:** Camera access requires an `HTTPS` context or `localhost` due to browser `getUserMedia` security constraints.

---

## License

Distributed under the [MIT License](LICENSE).
