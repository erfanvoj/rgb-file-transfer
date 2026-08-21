import { Chunker } from './protocol/chunker';
import { CanvasRenderer } from './sender/canvasRenderer';
import { Reassembler, type ReassemblerProgress } from './receiver/reassembler';
import { SENDER_CANVAS_SIZE } from './config';
import type { WorkerOutMessage, HudUpdateMessage } from './receiver/worker';
import type { TrackingState } from './receiver/anchorDetector';
import WorkerScript from './receiver/worker?worker';

const btnModeSend = document.getElementById('btn-mode-send') as HTMLButtonElement;
const btnModeReceive = document.getElementById('btn-mode-receive') as HTMLButtonElement;
const sectionSend = document.getElementById('section-send') as HTMLElement;
const sectionReceive = document.getElementById('section-receive') as HTMLElement;

const fileInput = document.getElementById('file-input') as HTMLInputElement;
const btnStartSend = document.getElementById('btn-start-send') as HTMLButtonElement;
const btnStopSend = document.getElementById('btn-stop-send') as HTMLButtonElement;
const senderCanvas = document.getElementById('sender-canvas') as HTMLCanvasElement;
const senderProgressBar = document.getElementById('sender-progress-bar') as HTMLElement;
const senderProgressText = document.getElementById('sender-progress') as HTMLElement;
const fileDetails = document.getElementById('file-details') as HTMLElement;
const senderMetrics = document.getElementById('sender-metrics') as HTMLElement;
const senderMetricPackets = document.getElementById('sender-metric-packets') as HTMLElement;
const senderMetricK = document.getElementById('sender-metric-k') as HTMLElement;

const receiverVideo = document.getElementById('receiver-video') as HTMLVideoElement;
const debugCanvas = document.getElementById('debug-canvas') as HTMLCanvasElement;
const receiverStatusPill = document.getElementById('receiver-status-pill') as HTMLElement | null;
const btnStartReceive = document.getElementById('btn-start-receive') as HTMLButtonElement;
const btnStopReceive = document.getElementById('btn-stop-receive') as HTMLButtonElement;
const receiverProgressBar = document.getElementById('receiver-progress-bar') as HTMLElement;
const receiverProgressText = document.getElementById('receiver-progress') as HTMLElement;
const receiverMetrics = document.getElementById('receiver-metrics') as HTMLElement;
const receiverMetricRank = document.getElementById('receiver-metric-rank') as HTMLElement;
const receiverMetricProgress = document.getElementById('receiver-metric-progress') as HTMLElement;
const receiverMetricPackets = document.getElementById('receiver-metric-packets') as HTMLElement;
const receiverMetricSpeed = document.getElementById('receiver-metric-speed') as HTMLElement;
const downloadArea = document.getElementById('download-area') as HTMLElement;
const downloadLink = document.getElementById('download-link') as HTMLAnchorElement;

let videoStream: MediaStream | null = null;
let captureCanvas: HTMLCanvasElement | null = null;
let captureCtx: CanvasRenderingContext2D | null = null;
let isStreaming = false;
let isWorkerBusy = false;
let animationFrameId = 0;
let lastCaptureTime = 0;

let chunker: Chunker | null = null;
let renderer: CanvasRenderer;
let reassembler: Reassembler;
let worker: Worker;

const thumbCanvas = document.createElement('canvas');
thumbCanvas.width = 100;
thumbCanvas.height = 100;
const thumbCtx = thumbCanvas.getContext('2d')!;

/**
 * Starts the device camera stream and initializes the frame dispatch loop.
 * Safari / iOS WebKit edge case: `loadedmetadata` can fire before video dimensions
 * settle; we ensure non-zero video width before binding the capture canvas.
 */
async function startCamera(): Promise<void> {
  isWorkerBusy = false;
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: 'environment',
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 60 },
    },
  });

  receiverVideo.srcObject = stream;
  videoStream = stream;

  await new Promise<void>((resolve) => {
    receiverVideo.onloadedmetadata = () => {
      receiverVideo.play();
      if (!captureCanvas) {
        captureCanvas = document.createElement('canvas');
        captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true, alpha: false })!;
      }
      captureCanvas.width = receiverVideo.videoWidth || 1280;
      captureCanvas.height = receiverVideo.videoHeight || 720;
      isStreaming = true;
      lastCaptureTime = performance.now();
      captureFrame(lastCaptureTime);
      resolve();
    };
  });
}

function stopCamera(): void {
  isStreaming = false;
  isWorkerBusy = false;
  cancelAnimationFrame(animationFrameId);

  if (videoStream) {
    videoStream.getTracks().forEach((track) => track.stop());
    videoStream = null;
    receiverVideo.srcObject = null;
  }
}

function captureFrame(timestamp: number): void {
  if (!isStreaming) return;

  if (receiverVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && captureCanvas && captureCtx) {
    const delta = timestamp - lastCaptureTime;
    // Cap worker dispatch rate to ~30 FPS (33ms) to avoid queue saturation while allowing zero-copy transfer
    if (delta >= 33.3 && !isWorkerBusy) {
      captureCtx.drawImage(receiverVideo, 0, 0, captureCanvas.width, captureCanvas.height);
      const imgData = captureCtx.getImageData(0, 0, captureCanvas.width, captureCanvas.height);

      isWorkerBusy = true;
      const buffer = imgData.data.buffer;

      // Transferable object transfers ArrayBuffer ownership without structured-clone overhead
      worker.postMessage(
        {
          type: 'FRAME',
          width: captureCanvas.width,
          height: captureCanvas.height,
          buffer,
        },
        [buffer]
      );
      lastCaptureTime = timestamp;
    }
  }

  animationFrameId = requestAnimationFrame(captureFrame);
}

function init() {
  btnModeSend.addEventListener('click', () => switchMode('send'));
  btnModeReceive.addEventListener('click', () => switchMode('receive'));

  senderCanvas.width = SENDER_CANVAS_SIZE;
  senderCanvas.height = SENDER_CANVAS_SIZE;

  renderer = new CanvasRenderer(senderCanvas, (current, total) => {
    senderProgressBar.style.width = '100%';
    senderProgressText.innerText = `Broadcasting Fountain code — packet #${current + 1} (K = ${total})`;
    if (senderMetricPackets) senderMetricPackets.innerText = (current + 1).toString();
    if (senderMetricK) senderMetricK.innerText = total.toString();
  });

  fileInput.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;

    fileDetails.innerText = `Reading ${file.name} — ${Math.round(file.size / 1024)} KB`;

    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    chunker = new Chunker(uint8Array, file.name, file.type);
    renderer.setChunker(chunker);

    btnStartSend.disabled = false;
    fileDetails.innerText = `${file.name} — ready, K = ${chunker.total} source chunks (${Math.round(file.size / 1024)} KB)`;
    if (senderMetricK) senderMetricK.innerText = chunker.total.toString();
    if (senderMetricPackets) senderMetricPackets.innerText = '0';
  });

  btnStartSend.addEventListener('click', () => {
    renderer.start();
    btnStartSend.disabled = true;
    btnStopSend.disabled = false;
    fileInput.disabled = true;
    if (senderMetrics) senderMetrics.classList.remove('hidden');
  });

  btnStopSend.addEventListener('click', () => {
    renderer.stop();
    btnStartSend.disabled = false;
    btnStopSend.disabled = true;
    fileInput.disabled = false;
    senderProgressText.innerText = 'Stream stopped';
  });

  worker = new WorkerScript();

  reassembler = new Reassembler(
    (stats: ReassemblerProgress) => {
      receiverProgressBar.style.width = `${stats.percentage}%`;
      receiverProgressText.innerText = `Decoding — Rank ${stats.rank}/${stats.totalChunks} (${stats.percentage}%)`;

      if (receiverMetrics) receiverMetrics.classList.remove('hidden');
      if (receiverMetricRank) receiverMetricRank.innerText = `${stats.rank} / ${stats.totalChunks}`;
      if (receiverMetricProgress) receiverMetricProgress.innerText = `${stats.percentage}%`;
      if (receiverMetricPackets) receiverMetricPackets.innerText = `${stats.validPackets} / ${stats.totalScanned}`;
      if (receiverMetricSpeed) receiverMetricSpeed.innerText = `${stats.effectiveSpeedKbps} KB/s`;
    },
    (blobUrl, metadata) => {
      stopCamera();
      btnStartReceive.disabled = false;
      btnStopReceive.disabled = true;

      downloadArea.classList.remove('hidden');
      downloadLink.href = blobUrl;
      downloadLink.download = (metadata as { name?: string }).name || 'received_file';
      downloadLink.innerText = `Download ${(metadata as { name?: string }).name || 'file'} — ${Math.round(
        ((metadata as { size?: number }).size || 0) / 1024
      )} KB`;

      receiverProgressText.innerText = 'File reconstructed successfully!';
      updateStatusPill('ORIENTATION_VERIFIED');
    }
  );

  const debugCtx = debugCanvas ? debugCanvas.getContext('2d') : null;

  worker.onmessage = (e: MessageEvent<WorkerOutMessage>) => {
    isWorkerBusy = false;
    if (e.data.type === 'CHUNK_RECEIVED') {
      reassembler.handlePacket(
        e.data.fileId,
        e.data.totalChunks,
        e.data.seed,
        e.data.payload
      );
    } else if (e.data.type === 'HUD_UPDATE') {
      reassembler.recordScannedFrame();
      renderHud(e.data, debugCtx);
    }
  };

  btnStartReceive.addEventListener('click', async () => {
    downloadArea.classList.add('hidden');
    reassembler.reset();
    worker.postMessage({ type: 'INIT' });
    receiverProgressBar.style.width = '0%';
    receiverProgressText.innerText = "Point your camera at the sender's screen";
    if (receiverMetrics) receiverMetrics.classList.remove('hidden');
    if (receiverMetricRank) receiverMetricRank.innerText = '0 / 0';
    if (receiverMetricProgress) receiverMetricProgress.innerText = '0%';
    if (receiverMetricPackets) receiverMetricPackets.innerText = '0 / 0';
    if (receiverMetricSpeed) receiverMetricSpeed.innerText = '0.0 KB/s';
    updateStatusPill('SEARCHING');

    try {
      await startCamera();
      btnStartReceive.disabled = true;
      btnStopReceive.disabled = false;
    } catch {
      alert("Couldn't access the camera. Make sure you're on HTTPS and have granted camera permission.");
    }
  });

  btnStopReceive.addEventListener('click', () => {
    stopCamera();
    btnStartReceive.disabled = false;
    btnStopReceive.disabled = true;
    receiverProgressText.innerText = 'Camera off';
    updateStatusPill('SEARCHING');
    if (debugCtx && debugCanvas) {
      debugCtx.clearRect(0, 0, debugCanvas.width, debugCanvas.height);
    }
  });
}

function updateStatusPill(state: TrackingState) {
  if (!receiverStatusPill) return;

  const label = receiverStatusPill.querySelector('.status-label') as HTMLElement | null;

  receiverStatusPill.classList.remove('status-searching', 'status-locked', 'status-verified');

  if (state === 'ORIENTATION_VERIFIED') {
    receiverStatusPill.classList.add('status-verified');
    if (label) label.innerText = 'State: ORIENTATION_VERIFIED';
  } else if (state === 'ANCHORS_LOCKED') {
    receiverStatusPill.classList.add('status-locked');
    if (label) label.innerText = 'State: ANCHORS_LOCKED';
  } else {
    receiverStatusPill.classList.add('status-searching');
    if (label) label.innerText = 'State: SEARCHING';
  }
}

function renderHud(data: HudUpdateMessage, debugCtx: CanvasRenderingContext2D | null) {
  if (!debugCtx || !debugCanvas) return;

  if (receiverVideo.videoWidth > 0 && debugCanvas.width !== receiverVideo.videoWidth) {
    debugCanvas.width = receiverVideo.videoWidth;
    debugCanvas.height = receiverVideo.videoHeight;
  }

  const { width, height } = debugCanvas;
  debugCtx.clearRect(0, 0, width, height);

  updateStatusPill(data.state);

  for (const c of data.candidates) {
    debugCtx.beginPath();
    debugCtx.arc(c.x, c.y, 8, 0, Math.PI * 2);

    if (c.color === 'magenta') {
      debugCtx.strokeStyle = '#FF00FF';
      debugCtx.fillStyle = 'rgba(255, 0, 255, 0.3)';
    } else {
      debugCtx.strokeStyle = '#00FFFF';
      debugCtx.fillStyle = 'rgba(0, 255, 255, 0.3)';
    }

    debugCtx.lineWidth = 2;
    debugCtx.fill();
    debugCtx.stroke();

    debugCtx.beginPath();
    debugCtx.arc(c.x, c.y, 2, 0, Math.PI * 2);
    debugCtx.fillStyle = '#FFFFFF';
    debugCtx.fill();
  }

  if (data.corners && data.corners.length === 4) {
    const [p0, p1, p2, p3] = data.corners;

    debugCtx.beginPath();
    debugCtx.moveTo(p0.x, p0.y);
    debugCtx.lineTo(p1.x, p1.y);
    debugCtx.lineTo(p2.x, p2.y);
    debugCtx.lineTo(p3.x, p3.y);
    debugCtx.closePath();

    debugCtx.strokeStyle = data.frameValid ? '#22c55e' : '#00FF66';
    debugCtx.lineWidth = 3;
    debugCtx.stroke();

    debugCtx.fillStyle = data.frameValid ? 'rgba(34, 197, 94, 0.15)' : 'rgba(0, 255, 102, 0.08)';
    debugCtx.fill();

    const cornerBadges = [
      { p: p0, label: 'TL (0)', color: '#FF00FF' },
      { p: p1, label: 'TR (1)', color: '#00FFFF' },
      { p: p2, label: 'BR (2)', color: '#00FFFF' },
      { p: p3, label: 'BL (3)', color: '#00FFFF' },
    ];

    debugCtx.font = 'bold 11px "JetBrains Mono", monospace';

    for (const badge of cornerBadges) {
      debugCtx.beginPath();
      debugCtx.arc(badge.p.x, badge.p.y, 6, 0, Math.PI * 2);
      debugCtx.fillStyle = badge.color;
      debugCtx.fill();
      debugCtx.strokeStyle = '#FFFFFF';
      debugCtx.lineWidth = 1.5;
      debugCtx.stroke();

      const textW = debugCtx.measureText(badge.label).width;
      const bx = badge.p.x + 8;
      const by = badge.p.y - 8;

      debugCtx.fillStyle = 'rgba(0, 0, 0, 0.8)';
      debugCtx.fillRect(bx - 3, by - 11, textW + 6, 14);
      debugCtx.fillStyle = badge.color;
      debugCtx.fillText(badge.label, bx, by);
    }
  }

  const thumbSize = 100;
  const pad = 14;
  const thumbX = width - thumbSize - pad;
  const thumbY = height - thumbSize - pad;

  if (data.thumbnailBuffer && thumbX > 0 && thumbY > 0) {
    const imgData = new ImageData(
      new Uint8ClampedArray(data.thumbnailBuffer as ArrayBuffer),
      thumbSize,
      thumbSize
    );
    thumbCtx.putImageData(imgData, 0, 0);

    debugCtx.drawImage(thumbCanvas, thumbX, thumbY, thumbSize, thumbSize);

    debugCtx.strokeStyle = data.frameValid ? '#22c55e' : '#00FFFF';
    debugCtx.lineWidth = 2;
    debugCtx.strokeRect(thumbX, thumbY, thumbSize, thumbSize);

    debugCtx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    debugCtx.fillRect(thumbX, thumbY - 16, thumbSize, 16);
    debugCtx.fillStyle = data.frameValid ? '#4ade80' : '#22d3ee';
    debugCtx.font = 'bold 9px "JetBrains Mono", monospace';
    debugCtx.fillText('WARPED (320x320)', thumbX + 6, thumbY - 4);
  }
}

function switchMode(mode: 'send' | 'receive') {
  if (mode === 'send') {
    btnModeSend.classList.add('active');
    btnModeReceive.classList.remove('active');
    sectionSend.classList.remove('hidden');
    sectionSend.classList.add('active');
    sectionReceive.classList.add('hidden');
    sectionReceive.classList.remove('active');

    if (!btnStopReceive.disabled) btnStopReceive.click();
  } else {
    btnModeReceive.classList.add('active');
    btnModeSend.classList.remove('active');
    sectionReceive.classList.remove('hidden');
    sectionReceive.classList.add('active');
    sectionSend.classList.add('hidden');
    sectionSend.classList.remove('active');

    if (!btnStopSend.disabled) btnStopSend.click();
  }
}

init();
