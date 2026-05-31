import {
  Mic,
  Usb,
  Cable,
  Settings,
  ListVideo,
  Circle,
  Square,
  Radio,
  Bluetooth,
  Cloud,
  Share2,
  Trash2,
  LogIn,
  LogOut,
  UploadCloud,
  CheckCircle2,
  Check,
  HardDrive,
  Search,
  Play,
  Pause,
  RefreshCw,
  Download,
  Folder,
  FolderPlus,
  FolderOpen,
  X,
  Sliders,
} from "lucide-react";
import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  auth,
  db,
  loginWithGoogle,
  logout,
  getAccessToken,
  setAccessToken,
} from "./lib/firebase";
import { onAuthStateChanged, User } from "firebase/auth";
import {
  collection,
  addDoc,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  deleteDoc,
  doc,
  updateDoc,
} from "firebase/firestore";

// === Types ===
enum OperationType {
  CREATE = "create",
  UPDATE = "update",
  DELETE = "delete",
  LIST = "list",
  GET = "get",
  WRITE = "write",
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

type RecordingFormat = "native_hq" | "native_lq";

interface AudioDevice {
  deviceId: string;
  label: string;
  kind: string;
  groupId: string;
}

// === Audio Processing Hook ===
const useAudioRecorder = (selectedFormat: "wav" | "128k" | "256k" | "320k") => {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("default");
  const [isRecording, setIsRecording] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [recordingTime, setRecordingTime] = useState(0); // in ms
  const [levels, setLevels] = useState({ left: -60, right: -60 });
  const [recordings, setRecordings] = useState<{ url: string; date: Date }[]>(
    [],
  );
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [fadeDuration, setFadeDuration] = useState<number>(0);
  const [isFadingOut, setIsFadingOut] = useState(false);

  const [channelMode, setChannelMode] = useState<"stereo" | "dupe-left">(() => {
    try {
      const saved = localStorage.getItem("audio_channel_mode");
      return saved === "stereo" || saved === "dupe-left" ? saved : "dupe-left";
    } catch {
      return "dupe-left";
    }
  });

  const [extraBoost, setExtraBoost] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("audio_extra_boost");
      return saved ? parseFloat(saved) : 1.0;
    } catch {
      return 1.0;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("audio_channel_mode", channelMode);
    } catch (e) {
      console.error(e);
    }
  }, [channelMode]);

  useEffect(() => {
    try {
      localStorage.setItem("audio_extra_boost", extraBoost.toString());
    } catch (e) {
      console.error(e);
    }
  }, [extraBoost]);

  // Refs for audio processing
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const analyserLRef = useRef<AnalyserNode | null>(null);
  const analyserRRef = useRef<AnalyserNode | null>(null);
  const fadeGainNodeRef = useRef<GainNode | null>(null);
  const inputGainLRef = useRef<GainNode | null>(null);
  const inputGainRRef = useRef<GainNode | null>(null);
  const destStreamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number>(0);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const timerIntervalRef = useRef<number | null>(null);

  const setChannelVolume = useCallback(
    (channel: "left" | "right", vol: number) => {
      // vol is 0-100. Original: 80 = gain of 1.0 (0 dB)
      // Applying physical/input +4dB boost (+4dB = ~1.585x linear gain)
      const MIC_BOOST = 1.585;

      let gainValue = 0;
      if (vol <= 80) {
        gainValue = vol / 80;
      } else {
        gainValue = 1.0 + ((vol - 80) / 20) * 3.0;
      }

      // Final gain with boost and the new channel/bluetooth preamp booster
      const finalGain = gainValue * MIC_BOOST * extraBoost;

      const targetNode =
        channel === "left" ? inputGainLRef.current : inputGainRRef.current;
      if (targetNode && audioContextRef.current) {
        targetNode.gain.setTargetAtTime(
          finalGain,
          audioContextRef.current.currentTime,
          0.05,
        );
      }
    },
    [extraBoost],
  );

  const initAudio = useCallback(async () => {
    setPermissionError(null);
    try {
      // Prompt for permission if haven't already
      const initialStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      const enumerated = await navigator.mediaDevices.enumerateDevices();
      const audioInfos = enumerated.filter((d) => d.kind === "audioinput");
      setDevices(audioInfos);

      if (audioInfos.length > 0 && selectedDeviceId === "default") {
        setSelectedDeviceId(audioInfos[0].deviceId);
      }

      // Stop initial stream since we are going to grab the specific selected device stream
      initialStream.getTracks().forEach((track) => track.stop());
    } catch (err) {
      console.error("Error requesting audio permissions", err);
      if (err instanceof Error) {
        if (err.name === "NotAllowedError") {
          setPermissionError(
            "Permissão negada pelo navegador. Verifique as configurações de privacidade do seu navegador e tente novamente.",
          );
        } else if (err.name === "NotFoundError") {
          setPermissionError("Nenhum microfone encontrado.");
        } else {
          setPermissionError(`Erro ao acessar microfone: ${err.message}`);
        }
      } else {
        setPermissionError("Erro desconhecido ao solicitar permissão.");
      }
    }
  }, [selectedDeviceId]);

  // Connect to the specific selected device whenever it changes
  useEffect(() => {
    if (selectedDeviceId === "default" && devices.length === 0) return;

    let active = true;

    const setupMeters = async () => {
      try {
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop());
        }
        if (
          audioContextRef.current &&
          audioContextRef.current.state !== "closed"
        ) {
          await audioContextRef.current
            .close()
            .catch((e) => console.warn("AudioContext close ignored", e));
        }

        const audioConstraints: MediaTrackConstraints =
          selectedDeviceId === "default"
            ? {}
            : { deviceId: { exact: selectedDeviceId } };

        audioConstraints.echoCancellation = false;
        audioConstraints.noiseSuppression = false;
        audioConstraints.autoGainControl = false;
        audioConstraints.channelCount = 2; // Request stereo if available
        audioConstraints.sampleRate = 48000;

        const constraints: MediaStreamConstraints = {
          audio: audioConstraints,
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);

        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;

        const ctx = new window.AudioContext({
          sampleRate: 48000,
          latencyHint: "interactive",
        });
        audioContextRef.current = ctx;

        const source = ctx.createMediaStreamSource(stream);

        const channelSplitter = ctx.createChannelSplitter(2);
        source.connect(channelSplitter);

        const inputGainL = ctx.createGain();
        const inputGainR = ctx.createGain();
        inputGainLRef.current = inputGainL;
        inputGainRRef.current = inputGainR;
        // Start with the +4dB boost applied (1.585x) scaled by our Bluetooth/Extra booster
        inputGainL.gain.value = 1.585 * extraBoost;
        inputGainR.gain.value = 1.585 * extraBoost;

        if (channelMode === "dupe-left") {
          // Send Left channel (0) to both gain nodes. This fixes silent/quiet right channel issues on Mono/Bluetooth inputs!
          channelSplitter.connect(inputGainL, 0);
          channelSplitter.connect(inputGainR, 0);
        } else {
          channelSplitter.connect(inputGainL, 0);
          try {
            channelSplitter.connect(inputGainR, 1);
          } catch {
            channelSplitter.connect(inputGainR, 0); // mono fallback
          }
        }

        const channelMerger = ctx.createChannelMerger(2);
        inputGainL.connect(channelMerger, 0, 0);
        inputGainR.connect(channelMerger, 0, 1);

        const gainNode = ctx.createGain();
        gainNode.gain.value = 1;
        fadeGainNodeRef.current = gainNode;
        channelMerger.connect(gainNode);

        // Add a dynamics compressor to prevent clipping and improve general audio quality
        const compressor = ctx.createDynamicsCompressor();
        // Set threshold slightly higher to reduce excessive squashing
        compressor.threshold.value = -6;
        compressor.knee.value = 30;
        compressor.ratio.value = 4;
        compressor.attack.value = 0.01;
        compressor.release.value = 0.25;

        gainNode.connect(compressor);

        const destination = ctx.createMediaStreamDestination();
        destStreamRef.current = destination.stream;
        compressor.connect(destination);

        const splitter = ctx.createChannelSplitter(2);
        compressor.connect(splitter);

        const analyserL = ctx.createAnalyser();
        const analyserR = ctx.createAnalyser();
        analyserL.fftSize = 2048;
        analyserR.fftSize = 2048;
        analyserL.smoothingTimeConstant = 0.75;
        analyserR.smoothingTimeConstant = 0.75;

        splitter.connect(analyserL, 0);
        // Attempt to connect right channel (fails if mic is purely mono sometimes)
        try {
          splitter.connect(analyserR, 1);
        } catch {
          // fallback to L channel for visual R channel if mono
          splitter.connect(analyserR, 0);
        }

        analyserLRef.current = analyserL;
        analyserRRef.current = analyserR;
        setAnalyser(analyserL);

        const calculateLevels = () => {
          if (!analyserLRef.current || !analyserRRef.current) return;

          const dataL = new Float32Array(analyserLRef.current.fftSize);
          const dataR = new Float32Array(analyserRRef.current.fftSize);

          analyserLRef.current.getFloatTimeDomainData(dataL);
          analyserRRef.current.getFloatTimeDomainData(dataR);

          const getDb = (data: Float32Array) => {
            let sumSq = 0;
            for (let i = 0; i < data.length; i++) sumSq += data[i] * data[i];
            const rms = Math.sqrt(sumSq / data.length);
            let db = 20 * Math.log10(rms);
            if (!isFinite(db) || db < -60) db = -60;
            return db;
          };

          const dbL = getDb(dataL);
          let dbR = getDb(dataR);

          // Force R to match L if the stream is totally silent on R but not L (common in mono mics)
          if (dbL > -55 && dbR <= -60) {
            dbR = dbL;
          }

          setLevels({ left: dbL, right: dbR });
          animationFrameRef.current = requestAnimationFrame(calculateLevels);
        };

        calculateLevels();
      } catch (err) {
        console.error("Error setting up meters", err);
      }
    };

    setupMeters();

    return () => {
      active = false;
      cancelAnimationFrame(animationFrameRef.current);
    };
  }, [selectedDeviceId, devices.length, channelMode, extraBoost]);

  const startRecording = useCallback(() => {
    console.log("startRecording clicked!", {
      destStream: !!destStreamRef.current,
      audioCtx: !!audioContextRef.current,
      fadeGain: !!fadeGainNodeRef.current,
    });
    if (
      !destStreamRef.current ||
      !audioContextRef.current ||
      !fadeGainNodeRef.current
    ) {
      console.warn("Cannot start recording. Missing refs.");
      return;
    }

    try {
      if (audioContextRef.current.state === "suspended") {
        audioContextRef.current.resume();
      }

      chunksRef.current = [];
      let supportedOptions: MediaRecorderOptions | undefined = undefined;
      let audioBitsPerSecond = 320000;
      switch (selectedFormat) {
        case "128k":
          audioBitsPerSecond = 128000;
          break;
        case "256k":
          audioBitsPerSecond = 256000;
          break;
        case "320k":
          audioBitsPerSecond = 320000;
          break;
        case "wav":
          audioBitsPerSecond = 1411200;
          break; // PCM approx
      }

      const mimeTypes = [
        "audio/webm;codecs=opus",
        "audio/webm;codecs=pcm",
        "audio/mp4;codecs=mp4a.40.2",
        "audio/ogg;codecs=opus",
      ];

      let mimeTypeToUse = "";
      for (const mime of mimeTypes) {
        if (MediaRecorder.isTypeSupported(mime)) {
          mimeTypeToUse = mime;
          break;
        }
      }

      if (mimeTypeToUse) {
        supportedOptions = { mimeType: mimeTypeToUse, audioBitsPerSecond };
      } else {
        supportedOptions = { audioBitsPerSecond };
      }

      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(destStreamRef.current, supportedOptions);
      } catch (err: any) {
        // Fallback without options if it fails due to high bitrate
        console.warn(
          "Failed to start with options, trying without options",
          err,
        );
        try {
          recorder = new MediaRecorder(destStreamRef.current);
        } catch (err2: any) {
          alert("Erro ao iniciar gravador: " + err2.message);
          return;
        }
      }
      mediaRecorderRef.current = recorder;

      mediaRecorderRef.current.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorderRef.current.onstop = () => {
        const mimeType = mediaRecorderRef.current?.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const url = URL.createObjectURL(blob);
        setRecordings((prev) => [{ url, date: new Date() }, ...prev]);
      };

      const ctx = audioContextRef.current;
      const gain = fadeGainNodeRef.current;

      gain.gain.cancelScheduledValues(ctx.currentTime);
      if (fadeDuration > 0) {
        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(1, ctx.currentTime + fadeDuration);
      } else {
        gain.gain.setValueAtTime(1, ctx.currentTime);
      }

      mediaRecorderRef.current.start(200);
      setIsRecording(true);
      startTimeRef.current = Date.now();
      setRecordingTime(0);

      timerIntervalRef.current = window.setInterval(() => {
        setRecordingTime(Date.now() - startTimeRef.current);
      }, 50);
    } catch (err) {
      console.error("Could not start recording", err);
      alert("Seu navegador não suporta a gravação nativa de áudio solicitada.");
    }
  }, [fadeDuration, selectedFormat]);

  const stopRecording = useCallback(() => {
    if (
      !mediaRecorderRef.current ||
      mediaRecorderRef.current.state === "inactive"
    )
      return;
    if (!audioContextRef.current || !fadeGainNodeRef.current) return;

    const finalizeStop = () => {
      mediaRecorderRef.current?.stop();
      setIsRecording(false);
      setIsFadingOut(false);
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
    };

    if (fadeDuration > 0 && !isFadingOut) {
      setIsFadingOut(true);
      const ctx = audioContextRef.current;
      const gain = fadeGainNodeRef.current;

      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeDuration);

      setTimeout(finalizeStop, fadeDuration * 1000);
    } else {
      finalizeStop();
    }
  }, [fadeDuration, isFadingOut]);

  useEffect(() => {
    const handleDeviceChange = () => {
      console.log("Devices changed, refreshing list...");
      initAudio();
    };
    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        handleDeviceChange,
      );
    };
  }, [initAudio]);

  return {
    initAudio,
    devices,
    selectedDeviceId,
    setSelectedDeviceId,
    startRecording,
    stopRecording,
    isRecording,
    isFadingOut,
    recordingTime,
    levels,
    recordings,
    setRecordings,
    analyser,
    fadeDuration,
    setFadeDuration,
    setChannelVolume,
    permissionError,
    selectBluetoothDevice: async () => {
      let currentDevices = devices;
      if (currentDevices.length === 0) {
        await initAudio();
        // Re-fetch enumerated devices after init
        const enumerated = await navigator.mediaDevices.enumerateDevices();
        currentDevices = enumerated.filter((d) => d.kind === "audioinput");
        setDevices(currentDevices);
      }

      const btKeywords = [
        "bluetooth",
        "bt ",
        "headset",
        "hands-free",
        "airpods",
        "buds",
        "stereo",
      ];
      const btDevice = currentDevices.find((d) =>
        btKeywords.some((key) => d.label.toLowerCase().includes(key)),
      );
      if (btDevice) {
        setSelectedDeviceId(btDevice.deviceId);
        return btDevice;
      }
      return null;
    },
    selectUSBDevice: async () => {
      let currentDevices = devices;
      if (currentDevices.length === 0) {
        await initAudio();
        const enumerated = await navigator.mediaDevices.enumerateDevices();
        currentDevices = enumerated.filter((d) => d.kind === "audioinput");
        setDevices(currentDevices);
      }

      const usbDevice = currentDevices.find(
        (d) =>
          d.label.toLowerCase().includes("usb") ||
          d.label.toLowerCase().includes("interface") ||
          d.label.toLowerCase().includes("focusrite") ||
          d.label.toLowerCase().includes("presonus") ||
          d.label.toLowerCase().includes("behringer"),
      );
      if (usbDevice) {
        setSelectedDeviceId(usbDevice.deviceId);
        return usbDevice;
      }
      return null;
    },
    channelMode,
    setChannelMode,
    extraBoost,
    setExtraBoost,
  };
};

// === Helper Components ===

const VUMeter = ({
  label,
  level,
  initialMuted = false,
  faderSide = "right",
  volume = 80,
  onVolumeChange,
  muted = false,
  onMuteChange,
}: {
  label: string;
  level: number;
  initialMuted?: boolean;
  faderSide?: "left" | "right";
  volume?: number;
  onVolumeChange?: (val: number) => void;
  muted?: boolean;
  onMuteChange?: (val: boolean) => void;
}) => {
  const [localVolume, setLocalVolume] = useState(volume);
  const [localMuted, setLocalMuted] = useState(initialMuted);
  const containerRef = useRef<HTMLDivElement>(null);
  const [sliderHeight, setSliderHeight] = useState(220);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (let entry of entries) {
        // Make the slider width exactly match the container's inner height, minus a tiny bit for the thumb to not clip.
        setSliderHeight(entry.contentRect.height - 10);
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const currentMuted = onMuteChange ? muted : localMuted;
  const currentVolume = onVolumeChange ? volume : localVolume;

  const handleVolumeChange = (v: number) => {
    if (onVolumeChange) {
      onVolumeChange(v);
    } else {
      setLocalVolume(v);
    }
  };

  const handleMuteToggle = () => {
    if (onMuteChange) {
      onMuteChange(!currentMuted);
    } else {
      setLocalMuted(!localMuted);
    }
  };

  const clampedDb = Math.max(-60, Math.min(0, level));
  let heightPct = ((clampedDb + 60) / 60) * 100;
  if (currentMuted) heightPct = 0;
  // Removed double-dip visually: We just show the real DB level coming back from the Analyser.

  const renderSegments = () => (
    <div className="w-4 sm:w-6 bg-zinc-950 rounded-sm px-[2px] py-[2px] flex flex-col-reverse overflow-hidden relative border border-zinc-800 shrink-0 my-2">
      {Array.from({ length: 32 }).map((_, i) => {
        const segmentRatio = i / 31;
        const isOn = segmentRatio * 100 <= heightPct;
        let activeClass =
          "bg-emerald-500 shadow-[0_0_5px_rgba(16,185,129,0.5)]";
        let inactiveClass = "bg-emerald-950/40";
        if (segmentRatio >= 0.85) {
          activeClass = "bg-red-600 shadow-[0_0_5px_rgba(220,38,38,0.5)]";
          inactiveClass = "bg-red-950/40";
        } else if (segmentRatio >= 0.65) {
          activeClass = "bg-amber-500 shadow-[0_0_5px_rgba(245,158,11,0.5)]";
          inactiveClass = "bg-amber-950/40";
        }
        return (
          <div
            key={i}
            className={`w-full flex-1 rounded-[1px] transition-colors duration-[50ms] ${isOn ? activeClass : inactiveClass}`}
            style={{ marginBottom: i === 31 ? 0 : "2px" }}
          />
        );
      })}
    </div>
  );

  return (
    <div className="flex flex-col items-center flex-1 bg-zinc-900 border border-zinc-800 rounded-lg p-2 w-full h-full my-1">
      <div className="flex w-full flex-col sm:flex-row justify-between items-center mb-1 sm:mb-2 px-1 text-[10px] sm:text-sm text-amber-500 font-bold uppercase overflow-hidden whitespace-nowrap text-center gap-1">
        <span>{label}</span>
        <span className="text-emerald-400 font-mono text-[9px] sm:text-xs">
          {currentMuted ? "-∞ db" : `${clampedDb.toFixed(1)} dB`}
        </span>
      </div>

      <div
        ref={containerRef}
        className="flex w-full flex-1 min-h-[220px] sm:min-h-[350px] relative justify-center items-stretch py-2 gap-1 bg-zinc-950/30 rounded border border-zinc-800/50 inner-shadow"
      >
        {/* LEFT LAYOUT */}
        {faderSide === "left" && (
          <>
            <div className="w-5 sm:w-8 flex flex-col justify-between items-end pr-1 text-[8px] sm:text-[10px] text-zinc-500 flex-shrink-0 leading-none py-2">
              <span>+12</span>
              <span>0</span>
              <span>-6</span>
              <span>-12</span>
              <span>-24</span>
              <span>-60</span>
            </div>

            <div className="relative flex justify-center items-center w-5 sm:w-6 shrink-0 z-10 mx-0.5">
              <div className="absolute top-0 bottom-0 w-[2px] bg-zinc-950 border-l border-r border-zinc-800 z-0" />
              <input
                type="range"
                min="0"
                max="100"
                value={currentVolume}
                onChange={(e) => handleVolumeChange(Number(e.target.value))}
                className="vertical-slider z-10 absolute top-1/2 left-1/2 m-0 origin-center"
                style={{
                  width: `${sliderHeight}px`,
                  transform: "translate(-50%, -50%) rotate(270deg)",
                }}
              />
            </div>

            {renderSegments()}
          </>
        )}

        {/* RIGHT LAYOUT */}
        {faderSide === "right" && (
          <>
            {renderSegments()}

            <div className="relative flex justify-center items-center w-5 sm:w-6 shrink-0 z-10 mx-0.5">
              <div className="absolute top-0 bottom-0 w-[2px] bg-zinc-950 border-l border-r border-zinc-800 z-0" />
              <input
                type="range"
                min="0"
                max="100"
                value={currentVolume}
                onChange={(e) => handleVolumeChange(Number(e.target.value))}
                className="vertical-slider z-10 absolute top-1/2 left-1/2 m-0 origin-center"
                style={{
                  width: `${sliderHeight}px`,
                  transform: "translate(-50%, -50%) rotate(270deg)",
                }}
              />
            </div>

            <div className="w-5 sm:w-8 flex flex-col justify-between items-start pl-1 text-[8px] sm:text-[10px] text-zinc-500 flex-shrink-0 leading-none py-2">
              <span>+12</span>
              <span>0</span>
              <span>-6</span>
              <span>-12</span>
              <span>-24</span>
              <span>-60</span>
            </div>
          </>
        )}
      </div>

      <div className="w-full flex justify-center mt-2 px-1">
        <button
          onClick={handleMuteToggle}
          className={`w-full py-1 rounded text-[9px] sm:text-xs font-bold transition-colors ${currentMuted ? "bg-amber-600 text-zinc-950 focus:ring-2 focus:ring-amber-500 ring-offset-zinc-900 ring-offset-2" : "bg-zinc-800/80 text-zinc-400 hover:bg-zinc-700"}`}
        >
          MUTE
        </button>
      </div>
    </div>
  );
};

// === Spectrum Analyzer Component ===
const SpectrumAnalyzer = ({ analyser }: { analyser: AnalyserNode | null }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaksRef = useRef<number[]>([]);
  const peakDecayRef = useRef<number[]>([]);

  useEffect(() => {
    if (!analyser || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resizeCanvas = () => {
      canvas.width = canvas.offsetWidth * (window.devicePixelRatio || 1);
      canvas.height = canvas.offsetHeight * (window.devicePixelRatio || 1);
    };
    resizeCanvas();

    const sampleRate = analyser.context?.sampleRate || 48000;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    let animationId: number;

    const fMin = 20;
    const fMax = 20000;
    const numBars = 31; // Exactly 31 standard 1/3-octave EQ style bands
    const Q = 4.2; // Precise narrow frequency band selectivity Q-factor

    const draw = () => {
      animationId = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      const width = canvas.width;
      const height = canvas.height;

      ctx.clearRect(0, 0, width, height);

      // Define responsive segment size and gap
      const dpr = window.devicePixelRatio || 1;
      const segmentHeight = Math.max(2, 3 * dpr);
      const segmentGap = Math.max(1, 1 * dpr);
      const totalSegmentHeight = segmentHeight + segmentGap;
      const totalSegments = Math.floor(height / totalSegmentHeight);

      // Initialize or scale peak buffers
      if (peaksRef.current.length !== numBars) {
        peaksRef.current = new Array(numBars).fill(0);
        peakDecayRef.current = new Array(numBars).fill(0);
      }

      const peaks = peaksRef.current;
      const peakDecay = peakDecayRef.current;

      const barWidth = width / numBars;
      const gap = Math.max(2, barWidth * 0.15); // proportional gap for clean spacing between columns
      const fillWidth = Math.max(1, barWidth - gap);

      for (let j = 0; j < numBars; j++) {
        // Calculate logarithmic center frequency for each band
        const fCenter = fMin * Math.pow(fMax / fMin, (j + 0.5) / numBars);

        // Compute precise lower and upper boundaries utilizing Q:4.2 bandpass filter selectivity
        const bandwidth = fCenter / Q;
        const fStart = Math.max(fMin, fCenter - bandwidth / 2);
        const fEnd = Math.min(fMax, fCenter + bandwidth / 2);

        // Convert the frequency bounds to FFT database binary indices
        const binStart = Math.min(bufferLength - 1, (fStart / (sampleRate / 2)) * bufferLength);
        const binEnd = Math.min(bufferLength - 1, (fEnd / (sampleRate / 2)) * bufferLength);

        let val = 0;
        const startIdx = Math.floor(binStart);
        const endIdx = Math.ceil(binEnd);

        if (startIdx === endIdx) {
          // If the bin range is flat (generally sub-bass levels), interpolate linearly between neighbor points
          const tIdx = binStart - startIdx;
          const nextIdx = Math.min(bufferLength - 1, startIdx + 1);
          val = dataArray[startIdx] + (dataArray[nextIdx] - dataArray[startIdx]) * tIdx;
        } else {
          // Select peak energy to preserve high-velocity transient drumbeats and vocal sibilance
          let maxVal = 0;
          for (let b = startIdx; b <= endIdx; b++) {
            if (b >= 0 && b < bufferLength) {
              if (dataArray[b] > maxVal) {
                maxVal = dataArray[b];
              }
            }
          }
          val = maxVal;
        }

        // Apply pre-emphasis curve to compensate for the logarithmic spectrum roll-off (making sure high-end and low-end display beautifully with extreme accuracy)
        const centerFreq = (fStart + fEnd) / 2;
        let correction = 1.0;
        if (centerFreq < 100) {
          correction = 1.35; // boost sub-bass/bass visual response
        } else if (centerFreq < 250) {
          correction = 1.2;  // boost lower mid-range responsivity
        } else if (centerFreq > 4000) {
          correction = 1.3;  // boost high frequency sparkle and sibilants which are visually quieter but high energy
        }
        val = Math.min(255, val * correction);

        // Active segments computation
        const valNormalized = val / 255;
        const activeSegments = Math.round(valNormalized * (totalSegments - 1));
        const x = j * barWidth;

        // Draw background empty/inactive segments (gives high-end professional hardware aesthetic)
        ctx.fillStyle = "rgba(39, 39, 42, 0.15)";
        for (let s = 0; s < totalSegments; s++) {
          const sy = height - (s + 1) * totalSegmentHeight + segmentGap;
          ctx.fillRect(x, sy, fillWidth, segmentHeight);
        }

        // Draw active colored segments on top
        for (let s = 0; s < activeSegments; s++) {
          const sy = height - (s + 1) * totalSegmentHeight + segmentGap;
          const pct = s / totalSegments;
          if (pct < 0.6) {
            ctx.fillStyle = "#10b981"; // emerald green (safe level)
          } else if (pct < 0.85) {
            ctx.fillStyle = "#eab308"; // amber/yellow (warm level)
          } else {
            ctx.fillStyle = "#ef4444"; // red (clipping level)
          }
          ctx.fillRect(x, sy, fillWidth, segmentHeight);
        }

        // Apply peak decay physics with segment coordinates
        let peakY = peaks[j] || 0;
        let decay = peakDecay[j] || 0;
        const currentBarHeight = activeSegments * totalSegmentHeight;

        if (currentBarHeight >= peakY) {
          peakY = currentBarHeight;
          decay = 0;
        } else {
          decay += 0.8 * dpr; // smooth gravity pulls peak indicator dot
          peakY -= decay;
          if (peakY < 0) peakY = 0;
        }

        peaks[j] = peakY;
        peakDecay[j] = decay;

        // Draw the peak indicator segment
        const peakSegmentIdx = Math.floor(peakY / totalSegmentHeight);
        if (peakSegmentIdx > 0 && peakSegmentIdx < totalSegments) {
          const py = height - (peakSegmentIdx + 1) * totalSegmentHeight + segmentGap;
          ctx.fillStyle = "rgba(244, 63, 94, 0.95)"; // vibrant warm rose-red peaks
          ctx.fillRect(x, py, fillWidth, segmentHeight);
        }
      }
    };

    draw();
    window.addEventListener("resize", resizeCanvas);

    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener("resize", resizeCanvas);
    };
  }, [analyser]);

  // Utility to map tick frequencies mathematically to the correct pixel coordinates
  const getLabelStyle = (freq: number) => {
    const fMin = 20;
    const fMax = 20000;
    const t = (Math.log10(freq) - Math.log10(fMin)) / (Math.log10(fMax) - Math.log10(fMin));
    let transform = "translateX(-50%)";
    let left = `${t * 100}%`;

    if (freq === 20) {
      transform = "none";
      left = "8px";
    } else if (freq === 20000) {
      transform = "translateX(-100%)";
      left = "calc(100% - 8px)";
    }

    return { left, transform };
  };

  const FREQ_TICKS = [
    { label: "20Hz", freq: 20 },
    { label: "100", freq: 100 },
    { label: "200", freq: 200 },
    { label: "500", freq: 500 },
    { label: "1K", freq: 1000 },
    { label: "2K", freq: 2000 },
    { label: "5K", freq: 5000 },
    { label: "10K", freq: 10000 },
    { label: "20K", freq: 20000 },
  ];

  return (
    <div className="w-full h-full bg-black flex flex-col justify-between border-y border-zinc-800/50 relative overflow-hidden">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full opacity-90"
      />

      {/* Screen Title overlay helper */}
      <div
        className="absolute top-1 left-0 right-0 p-1 flex justify-center 
                       text-[10px] sm:text-xs text-emerald-500 font-black tracking-[0.3em] 
                       mix-blend-screen opacity-50 z-10 pointer-events-none uppercase drop-shadow-md"
      >
        FREQUENCY LEVELS • Q: 4.2
      </div>

      {/* Logarithmically distributed reference labels wrapper */}
      <div
        className="absolute bottom-0 left-0 right-0 h-4 px-2 pb-0.5 flex flex-row
                       text-[8px] sm:text-[10px] text-zinc-400 font-bold tracking-widest 
                       mix-blend-screen bg-black/40 z-10 pointer-events-none"
      >
        {FREQ_TICKS.map((tick) => {
          const { left, transform } = getLabelStyle(tick.freq);
          return (
            <span
              key={tick.label}
              className="absolute"
              style={{ left, transform }}
            >
              {tick.label}
            </span>
          );
        })}
      </div>
    </div>
  );
};

// === Main Application UI ===

const getDeviceCategory = (device: {
  label: string;
}): "usb" | "bt" | "aux" | "local" => {
  const lbl = device.label.toLowerCase();
  if (lbl.includes("usb") || lbl.includes("interface")) return "usb";
  if (
    lbl.includes("bluetooth") ||
    lbl.includes("bt ") ||
    lbl.includes("headset") ||
    lbl.includes("hands-free") ||
    lbl.includes("airpods") ||
    lbl.includes("buds")
  )
    return "bt";
  if (
    lbl.includes("aux") ||
    lbl.includes("line") ||
    lbl.includes("jack") ||
    lbl.includes("linha") ||
    lbl.includes("rear") ||
    lbl.includes("front") ||
    lbl.includes("p2")
  )
    return "aux";
  return "local";
};

export default function App() {
  const [selectedFormat, setSelectedFormat] = useState<
    "wav" | "128k" | "256k" | "320k"
  >("wav");

  const {
    initAudio,
    devices,
    selectedDeviceId,
    setSelectedDeviceId,
    startRecording,
    stopRecording,
    isRecording,
    isFadingOut,
    recordingTime,
    levels,
    recordings,
    setRecordings,
    analyser,
    fadeDuration,
    setFadeDuration,
    setChannelVolume,
    permissionError,
    selectBluetoothDevice,
    selectUSBDevice,
    channelMode,
    setChannelMode,
    extraBoost,
    setExtraBoost,
  } = useAudioRecorder(selectedFormat);

  const [buttonHeight, setButtonHeight] = useState<number | null>(null);
  const gridButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const updateHeight = () => {
      if (gridButtonRef.current) {
        setButtonHeight(gridButtonRef.current.offsetHeight);
      }
    };
    // Run after paint
    const timer = setTimeout(updateHeight, 150);
    window.addEventListener("resize", updateHeight);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", updateHeight);
    };
  }, []);

  const handleSelectBT = async () => {
    const device = await selectBluetoothDevice();
    if (!device) {
      alert(
        "Nenhum dispositivo Bluetooth detectado. Certifique-se de que seu fone ou microfone Bluetooth está conectado ao sistema.",
      );
    }
  };

  const handleSelectUSB = async () => {
    const device = await selectUSBDevice();
    if (!device) {
      alert(
        "Nenhuma Interface de Áudio USB detectada. Conecte sua interface ou verifique se o driver está instalado.",
      );
    }
  };

  const handleSelectLocal = () => {
    const local = devices.find((d) => getDeviceCategory(d) === "local");
    if (local) {
      setSelectedDeviceId(local.deviceId);
    } else if (devices.length > 0) {
      setSelectedDeviceId(devices[0].deviceId);
    }
  };

  const handleSelectAUX = () => {
    const aux = devices.find((d) => getDeviceCategory(d) === "aux");
    if (aux) {
      setSelectedDeviceId(aux.deviceId);
    } else {
      alert("Nenhum dispositivo AUX/P2 detectado.");
    }
  };

  const [activeTab, setActiveTab] = useState<
    "config" | "recordings" | "cloud" | "drive"
  >("config");
  const [user, setUser] = useState<User | null>(null);
  const [cloudRecordings, setCloudRecordings] = useState<any[]>([]);
  const [isUploading, setIsUploading] = useState<string | null>(null);
  const [sharedRecording, setSharedRecording] = useState<any | null>(null);
  const [volL, setVolL] = useState(80);
  const [volR, setVolR] = useState(80);
  const [mutedL, setMutedL] = useState(false);
  const [mutedR, setMutedR] = useState(false);

  // Google Drive states
  const [driveAccessToken, setDriveAccessToken] = useState<string | null>(
    getAccessToken(),
  );
  const [googleDriveFiles, setGoogleDriveFiles] = useState<any[]>([]);
  const [isDriveLoading, setIsDriveLoading] = useState(false);
  const [driveSearch, setDriveSearch] = useState("");
  const [isUploadingToDrive, setIsUploadingToDrive] = useState<string | null>(
    null,
  );
  const [currentlyPlayingDriveFile, setCurrentlyPlayingDriveFile] = useState<
    string | null
  >(null);
  const [driveAudioUrl, setDriveAudioUrl] = useState<string | null>(null);
  const [selectedDriveIds, setSelectedDriveIds] = useState<string[]>([]);

  // Google Drive folder selection states
  const [targetDriveFolder, setTargetDriveFolder] = useState<{
    id: string;
    name: string;
  } | null>(() => {
    try {
      const saved = localStorage.getItem("target_drive_folder");
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const [driveFolders, setDriveFolders] = useState<any[]>([]);
  const [isFoldersLoading, setIsFoldersLoading] = useState(false);
  const [showFolderModal, setShowFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [folderSearchText, setFolderSearchText] = useState("");
  const [showOnlyFolderFiles, setShowOnlyFolderFiles] = useState(true);

  useEffect(() => {
    try {
      if (targetDriveFolder) {
        localStorage.setItem(
          "target_drive_folder",
          JSON.stringify(targetDriveFolder),
        );
      } else {
        localStorage.removeItem("target_drive_folder");
      }
    } catch (e) {
      console.error(e);
    }
  }, [targetDriveFolder]);

  useEffect(() => {
    setChannelVolume("left", mutedL ? 0 : volL);
  }, [volL, mutedL, setChannelVolume]);

  useEffect(() => {
    setChannelVolume("right", mutedR ? 0 : volR);
  }, [volR, mutedR, setChannelVolume]);

  // Selection states
  const [selectedLocalUrls, setSelectedLocalUrls] = useState<string[]>([]);
  const [selectedCloudIds, setSelectedCloudIds] = useState<string[]>([]);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const recId = urlParams.get("rec");
    if (recId) {
      // Fetch public recording
      import("./lib/firebase").then(async ({ db }) => {
        const { getDoc, doc } = await import("firebase/firestore");
        const docSnap = await getDoc(doc(db, "recordings", recId));
        if (docSnap.exists()) {
          const data = docSnap.data();
          if (data.isPublic) {
            setSharedRecording({ id: docSnap.id, ...data });
          } else {
            alert("Esta gravação não está mais pública.");
          }
        }
      });
    }
  }, []);

  useEffect(() => {
    // Initial load: Try to get devices if permission was already granted.
    // Enumerate devices doesn't prompt, but it only returns labels if permission was granted.
    const checkPermissionAndInit = async () => {
      try {
        const result = await navigator.permissions.query({
          name: "microphone" as PermissionName,
        });
        if (result.state === "granted") {
          initAudio();
        }
      } catch (e) {
        // Fallback for browsers that don't support permissions.query for microphone
        // We don't call initAudio here to avoid automatic prompt on load.
      }
    };
    checkPermissionAndInit();
  }, [initAudio]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setDriveAccessToken(getAccessToken());
    });
    return () => unsubscribe();
  }, []);

  const handleGoogleLogin = async () => {
    try {
      await loginWithGoogle();
      const token = getAccessToken();
      setDriveAccessToken(token);
    } catch (err) {
      console.error("Login error:", err);
    }
  };

  const handleLogout = async () => {
    await logout();
    setDriveAccessToken(null);
    setGoogleDriveFiles([]);
    // Reset play state
    setCurrentlyPlayingDriveFile(null);
    if (driveAudioUrl) {
      URL.revokeObjectURL(driveAudioUrl);
      setDriveAudioUrl(null);
    }
  };

  const loadDriveFiles = useCallback(
    async (tokenToUse?: string) => {
      const token = tokenToUse || getAccessToken() || driveAccessToken;
      if (!token) return;
      setIsDriveLoading(true);
      try {
        // Find audio files in Google Drive (optionally restricted to chosen folder)
        let folderQuery = "";
        if (targetDriveFolder && showOnlyFolderFiles) {
          folderQuery = `'${targetDriveFolder.id}' in parents and `;
        }
        const queryStr = encodeURIComponent(
          `${folderQuery}(mimeType contains 'audio/' or name contains '.webm' or name contains '.wav' or name contains '.mp3' or name contains '.m4a' or name contains '.ogg') and trashed = false`,
        );
        const res = await fetch(
          `https://www.googleapis.com/drive/v3/files?q=${queryStr}&fields=files(id,name,mimeType,size,createdTime)&orderBy=createdTime desc&pageSize=100`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        );
        if (!res.ok) {
          if (res.status === 401) {
            setAccessToken(null);
            setDriveAccessToken(null);
          }
          throw new Error(`Google Drive API error: ${res.statusText}`);
        }
        const data = await res.json();
        setGoogleDriveFiles(data.files || []);
      } catch (err) {
        console.error("Error fetching from Google Drive:", err);
      } finally {
        setIsDriveLoading(false);
      }
    },
    [driveAccessToken, targetDriveFolder, showOnlyFolderFiles],
  );

  const loadDriveFolders = useCallback(async () => {
    const token = getAccessToken() || driveAccessToken;
    if (!token) return;
    setIsFoldersLoading(true);
    try {
      const queryStr = encodeURIComponent(
        "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      );
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${queryStr}&fields=files(id,name,createdTime)&orderBy=name&pageSize=100`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );
      if (!res.ok) throw new Error("Failed to load drive folders");
      const data = await res.json();
      setDriveFolders(data.files || []);
    } catch (err) {
      console.error("Error fetching folders:", err);
    } finally {
      setIsFoldersLoading(false);
    }
  }, [driveAccessToken]);

  const createDriveFolder = async (name: string) => {
    const token = getAccessToken() || driveAccessToken;
    if (!token) {
      alert("Por favor, conecte ao Google Drive primeiro.");
      return;
    }
    if (!name.trim()) {
      alert("Por favor, digite um nome válido para a pasta.");
      return;
    }
    setIsCreatingFolder(true);
    try {
      const res = await fetch("https://www.googleapis.com/drive/v3/files", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: name.trim(),
          mimeType: "application/vnd.google-apps.folder",
        }),
      });
      if (!res.ok) throw new Error("Failed to create folder");
      const folder = await res.json();
      setNewFolderName("");
      await loadDriveFolders();
      setTargetDriveFolder({ id: folder.id, name: folder.name });
    } catch (err) {
      console.error("Error creating folder:", err);
      alert("Erro ao criar pasta no Google Drive.");
    } finally {
      setIsCreatingFolder(false);
    }
  };

  useEffect(() => {
    if (showFolderModal && (getAccessToken() || driveAccessToken)) {
      loadDriveFolders();
    }
  }, [showFolderModal, driveAccessToken, loadDriveFolders]);

  useEffect(() => {
    if (activeTab === "drive" && (getAccessToken() || driveAccessToken)) {
      loadDriveFiles();
    }
  }, [activeTab, driveAccessToken, loadDriveFiles]);

  const playDriveFile = async (fileId: string) => {
    const token = getAccessToken() || driveAccessToken;
    if (!token) {
      alert("Por favor, conecte ao Google Drive primeiro.");
      return;
    }

    try {
      if (currentlyPlayingDriveFile === fileId) {
        setCurrentlyPlayingDriveFile(null);
        if (driveAudioUrl) {
          URL.revokeObjectURL(driveAudioUrl);
          setDriveAudioUrl(null);
        }
        return;
      }

      setCurrentlyPlayingDriveFile(fileId);
      if (driveAudioUrl) {
        URL.revokeObjectURL(driveAudioUrl);
        setDriveAudioUrl(null);
      }

      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      if (!res.ok) {
        throw new Error(`Could not load media: ${res.statusText}`);
      }

      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      setDriveAudioUrl(objectUrl);
    } catch (error) {
      console.error("Error playing file from Google Drive:", error);
      alert("Erro ao carregar áudio do Google Drive.");
      setCurrentlyPlayingDriveFile(null);
    }
  };

  const uploadToGoogleDrive = async (localRec: { url: string; date: Date }) => {
    const token = getAccessToken() || driveAccessToken;
    if (!token) {
      alert("Faça login e conecte ao Google Drive para salvar.");
      return;
    }

    try {
      setIsUploadingToDrive(localRec.url);
      const response = await fetch(localRec.url);
      const blob = await response.blob();

      const filename = `IsuAudio_${localRec.date.toISOString().slice(0, 10)}_${localRec.date.toTimeString().slice(0, 8).replace(/:/g, "-")}.webm`;

      // Upload to Google Drive
      const metadata: any = {
        name: filename,
        mimeType: blob.type || "audio/webm",
      };

      if (targetDriveFolder) {
        metadata.parents = [targetDriveFolder.id];
      }

      const base64Promise = new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(",")[1];
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      const base64Content = await base64Promise;

      const boundary = "foo_bar_baz_boundary";
      const delimiter = `\r\n--${boundary}\r\n`;
      const closeDelimiter = `\r\n--${boundary}--`;

      const metadataPart =
        "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
        JSON.stringify(metadata);
      const mediaPart = `Content-Type: ${blob.type || "audio/webm"}\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Content}`;

      const multipartBody =
        delimiter + metadataPart + delimiter + mediaPart + closeDelimiter;

      const res = await fetch(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": `multipart/related; boundary=${boundary}`,
          },
          body: multipartBody,
        },
      );

      if (!res.ok) {
        throw new Error(`Google Upload Error: ${res.statusText}`);
      }

      alert("Salvo no seu Google Drive com sucesso!");
      if (activeTab === "drive") {
        loadDriveFiles();
      }
    } catch (error) {
      console.error("Erro ao salvar no Google Drive:", error);
      alert("Erro ao salvar no Google Drive.");
    } finally {
      setIsUploadingToDrive(null);
    }
  };

  const deleteDriveFile = async (fileId: string, fileName: string) => {
    const token = getAccessToken() || driveAccessToken;
    if (!token) return;

    const confirmed = window.confirm(
      `Tem certeza que deseja excluir o arquivo "${fileName}" do seu Google Drive? Esta ação não pode ser desfeita e removerá permanentemente os dados com sua permissão.`,
    );
    if (!confirmed) return;

    try {
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      if (!res.ok) {
        throw new Error(`Delete failed: ${res.statusText}`);
      }

      alert("Arquivo excluído com sucesso do Google Drive.");

      if (currentlyPlayingDriveFile === fileId) {
        setCurrentlyPlayingDriveFile(null);
        if (driveAudioUrl) {
          URL.revokeObjectURL(driveAudioUrl);
          setDriveAudioUrl(null);
        }
      }

      loadDriveFiles();
    } catch (error) {
      console.error("Error deleting from Google Drive:", error);
      alert("Erro ao excluir do Google Drive.");
    }
  };

  const bulkDeleteDrive = async () => {
    const token = getAccessToken() || driveAccessToken;
    if (!token || selectedDriveIds.length === 0) return;

    const confirmed = window.confirm(
      `Tem certeza que deseja excluir as ${selectedDriveIds.length} gravações selecionadas do seu Google Drive? Esta ação é definitiva e apagará permanentemente esses arquivos.`,
    );
    if (!confirmed) return;

    try {
      setIsDriveLoading(true);
      for (const id of selectedDriveIds) {
        await fetch(`https://www.googleapis.com/drive/v3/files/${id}`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
      }
      setSelectedDriveIds([]);
      alert("Gravações excluídas com sucesso!");
      loadDriveFiles();
    } catch (error) {
      console.error("Error bulk deleting from drive:", error);
      alert("Erro ao excluir arquivos do Google Drive.");
    } finally {
      setIsDriveLoading(false);
    }
  };

  useEffect(() => {
    if (!user) {
      setCloudRecordings([]);
      return;
    }

    const q = query(
      collection(db, "recordings"),
      where("userId", "==", user.uid),
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const recs = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));
        setCloudRecordings(
          recs.sort((a: any, b: any) => {
            const timeA = a.createdAt?.seconds || 0;
            const timeB = b.createdAt?.seconds || 0;
            return timeB - timeA;
          }),
        );
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, "recordings");
      },
    );

    return () => unsubscribe();
  }, [user]);

  const uploadToCloud = async (localRec: {
    url: string;
    date: Date;
    blob?: Blob;
  }) => {
    if (!user) {
      alert("Faça login para salvar na nuvem.");
      return;
    }

    try {
      setIsUploading(localRec.url);
      const response = await fetch(localRec.url);
      const blob = await response.blob();

      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve) => {
        reader.onloadend = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
      });
      const base64 = await base64Promise;

      try {
        await addDoc(collection(db, "recordings"), {
          userId: user.uid,
          userEmail: user.email,
          title: `Gravação ${localRec.date.toLocaleString()}`,
          audioData: base64,
          createdAt: serverTimestamp(),
          mimeType: blob.type,
          isPublic: false,
        });
      } catch (e) {
        handleFirestoreError(e, OperationType.CREATE, "recordings");
      }

      alert("Salvo na nuvem com sucesso!");
    } catch (error) {
      console.error("Erro ao subir para nuvem:", error);
      alert("Erro ao salvar na nuvem.");
    } finally {
      setIsUploading(null);
    }
  };

  const handleFirestoreError = (
    error: unknown,
    operationType: OperationType,
    path: string | null,
  ) => {
    const errInfo: FirestoreErrorInfo = {
      error: error instanceof Error ? error.message : String(error),
      authInfo: {
        userId: auth.currentUser?.uid,
        email: auth.currentUser?.email,
        emailVerified: auth.currentUser?.emailVerified,
        isAnonymous: auth.currentUser?.isAnonymous,
        tenantId: auth.currentUser?.tenantId,
        providerInfo:
          auth.currentUser?.providerData?.map((provider) => ({
            providerId: provider.providerId,
            email: provider.email,
          })) || [],
      },
      operationType,
      path,
    };
    console.error("Firestore Error: ", JSON.stringify(errInfo));
    throw new Error(JSON.stringify(errInfo));
  };

  const deleteLocalRecording = (url: string) => {
    console.log("Attempting to delete local recording:", url);
    setRecordings((prev) => {
      console.log("Filtering recordings. Prev count:", prev.length);
      return prev.filter((r) => r.url !== url);
    });
    setSelectedLocalUrls((prev) => prev.filter((u) => u !== url));
    URL.revokeObjectURL(url);
  };

  const bulkDeleteLocal = () => {
    console.log(
      "Attempting bulk delete local. Selected:",
      selectedLocalUrls.length,
    );
    if (selectedLocalUrls.length === 0) return;

    setRecordings((prev) => {
      const filtered = prev.filter((r) => !selectedLocalUrls.includes(r.url));
      // Clean up blobs
      prev.forEach((r) => {
        if (selectedLocalUrls.includes(r.url)) {
          console.log("Revoking object URL:", r.url);
          URL.revokeObjectURL(r.url);
        }
      });
      return filtered;
    });
    setSelectedLocalUrls([]);
  };

  const bulkDeleteCloud = async () => {
    console.log(
      "Attempting bulk delete cloud. Selected:",
      selectedCloudIds.length,
    );
    if (selectedCloudIds.length === 0) return;

    try {
      const deletePromises = selectedCloudIds.map((id) => {
        console.log("Deleting cloud doc:", id);
        return deleteDoc(doc(db, "recordings", id));
      });
      await Promise.all(deletePromises);
      setSelectedCloudIds([]);
      alert("Excluídos com sucesso!");
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, "recordings");
    }
  };

  const deleteCloudRecording = async (id: string) => {
    console.log("Attempting to delete cloud recording:", id);
    try {
      console.log("Deleting cloud doc:", id);
      await deleteDoc(doc(db, "recordings", id));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `recordings/${id}`);
    }
  };

  const toggleShare = async (id: string, currentStatus: boolean) => {
    try {
      await updateDoc(doc(db, "recordings", id), {
        isPublic: !currentStatus,
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `recordings/${id}`);
    }
  };

  const copyShareLink = (id: string) => {
    const url = `${window.location.origin}?rec=${id}`;
    navigator.clipboard.writeText(url);
    alert("Link de compartilhamento copiado!");
  };

  // Format mm:ss:ms
  const ms = recordingTime % 1000;
  const secs = Math.floor(recordingTime / 1000) % 60;
  const mins = Math.floor(recordingTime / 60000) % 60;
  const strMins = mins.toString().padStart(2, "0");
  const strSecs = secs.toString().padStart(2, "0");
  const strMs = ms.toString().padStart(3, "0").substring(0, 2);

  const getDeviceIconAndLabel = (device: AudioDevice) => {
    const l = device.label.toLowerCase();
    if (l.includes("usb") || l.includes("interface")) {
      return {
        icon: <Usb size={22} className="mb-1" />,
        type: "USB INTERFACE",
        desc: device.label || "Interface Externa",
        theme: {
          border: "border-red-500",
          bg: "bg-red-500/10",
          text: "text-red-500",
          hover: "hover:border-red-500/50 hover:text-red-400",
        },
      };
    }
    if (l.includes("bluetooth") || l.includes("bt ")) {
      return {
        icon: <Bluetooth size={22} className="mb-1" />,
        type: "BLUETOOTH",
        desc: "ÁUDIO EXTERNO",
        theme: {
          border: "border-blue-600",
          bg: "bg-blue-600/10",
          text: "text-blue-500",
          hover: "hover:border-blue-500/50 hover:text-blue-400",
        },
      };
    }
    if (
      l.includes("default") ||
      l.includes("padrão") ||
      l.includes("built-in") ||
      l.includes("integrado") ||
      l.length === 0
    ) {
      return {
        icon: <Mic size={22} className="mb-1" />,
        type: "MICROFONE LOCAL",
        desc: "Integrado / Padrão",
        theme: {
          border: "border-pink-500",
          bg: "bg-pink-500/10",
          text: "text-pink-500",
          hover: "hover:border-pink-500/50 hover:text-pink-400",
        },
      };
    }
    return {
      icon: <Cable size={22} className="mb-1" />,
      type: "P2 / AUX",
      desc: device.label || "Headset earpiece",
      theme: {
        border: "border-violet-500",
        bg: "bg-violet-500/10",
        text: "text-violet-500",
        hover: "hover:border-violet-500/50 hover:text-violet-400",
      },
    };
  };

  return (
    <div className="h-dvh overflow-hidden flex flex-col font-sans selection:bg-amber-500/30">
      {/* Top Navbar */}
      <header className="bg-zinc-950 border-b border-zinc-800 py-1.5 px-3 flex flex-row justify-center items-center z-10 shrink-0">
        <div className="flex items-center space-x-2">
          <div className="h-6 w-6 bg-amber-500 rounded flex items-center justify-center text-zinc-950 shrink-0">
            <Radio size={14} />
          </div>
          <div className="flex flex-col">
            <h1 className="text-amber-500 font-black tracking-widest text-xs leading-none uppercase font-mono">
              ÍSU - ÁUDIO
            </h1>
            <p className="text-[8px] text-zinc-500 tracking-[0.2em] uppercase font-bold mt-0.5 leading-none">
              Professional Audio Recorder
            </p>
          </div>
        </div>
      </header>

      {/* Main Content Resizes */}
      <main className="flex-1 flex flex-col overflow-y-auto overflow-x-hidden max-w-[1400px] w-full mx-auto pb-4 custom-scrollbar">
        {/* Mixer Area */}
        <div className="flex flex-row flex-1 px-1 sm:px-6 gap-1 sm:gap-6 md:gap-10 justify-between items-stretch min-h-[240px] md:min-h-[400px] mb-2 overflow-hidden">
          <div className="w-[85px] sm:w-[130px] flex shrink-0">
            <VUMeter
              label="CANAL L"
              level={levels.left}
              faderSide="left"
              volume={volL}
              onVolumeChange={(val) => {
                setVolL(val);
              }}
              muted={mutedL}
              onMuteChange={setMutedL}
            />
          </div>

          {/* Central Control Panel */}
          <div className="flex flex-col items-center justify-center py-2 shrink-0 z-10 flex-1 max-w-[160px] sm:max-w-[450px] mx-auto h-full min-h-[240px] md:min-h-[400px]">
            <div className="bg-zinc-950 border border-zinc-800 rounded-2xl p-2 sm:p-5 shadow-2xl flex flex-col items-center w-full h-full justify-between">
              <div className="flex flex-col items-center">
                <div className="text-xl sm:text-4xl font-mono text-zinc-100 font-bold mb-1 tabular-nums tracking-tighter whitespace-nowrap bg-zinc-950 p-2 sm:p-4 rounded-lg border border-zinc-700/50 min-w-[140px] sm:min-w-[200px] text-center">
                  {strMins}:{strSecs}.{strMs}
                </div>
                <div
                  className={`mt-2 text-[8px] sm:text-[10px] font-black tracking-widest mb-2 uppercase ${isRecording ? "text-red-500 animate-pulse" : "text-zinc-600"}`}
                >
                  {isRecording
                    ? isFadingOut
                      ? "Finalizando..."
                      : "Gravando"
                    : "Pronto"}
                </div>
              </div>

              <div className="flex flex-col items-center space-y-6 sm:space-y-10 mt-0 mb-8 sm:mb-20">
                {/* Record Button */}
                <button
                  onClick={startRecording}
                  disabled={isRecording || devices.length === 0}
                  className={`h-14 w-14 sm:h-20 sm:w-20 rounded-full flex items-center justify-center transition-all ${
                    isRecording
                      ? "bg-red-500/20 border-2 border-red-500 rotate-[360deg] duration-1000 shadow-[0_0_15px_rgba(239,68,68,0.5)]"
                      : "bg-zinc-900 border-2 border-red-900 hover:border-red-500 hover:bg-zinc-800"
                  }`}
                >
                  <Circle
                    className={`fill-current ${isRecording ? "text-red-500 scale-110" : "text-red-600"}`}
                    size={24}
                  />
                </button>

                {/* Stop Button */}
                <button
                  onClick={stopRecording}
                  disabled={!isRecording}
                  className={`h-12 w-12 sm:h-14 sm:w-14 rounded-xl flex items-center justify-center transition-all border-2 border-white ${
                    isRecording
                      ? "bg-zinc-800 hover:bg-zinc-700 text-white shadow-md"
                      : "bg-zinc-900/50 text-white cursor-not-allowed opacity-50"
                  }`}
                >
                  <Square className="fill-current" size={18} />
                </button>
              </div>
            </div>
          </div>

          <div className="w-[85px] sm:w-[130px] flex shrink-0">
            <VUMeter
              label="CANAL R"
              level={levels.right}
              faderSide="right"
              volume={volR}
              onVolumeChange={(val) => {
                setVolR(val);
              }}
              muted={mutedR}
              onMuteChange={setMutedR}
            />
          </div>
        </div>

        {/* Global Spectrum Analyzer */}
        <div className="w-full shrink-0 mb-2 h-[110px] sm:mb-4 sm:h-[200px]">
          <SpectrumAnalyzer analyser={analyser} />
        </div>

        {/* Bottom Panel */}
        <div className="px-1 sm:px-4 mt-2 z-20 flex flex-col w-full">
          <div className="bg-zinc-900/80 border border-zinc-800 border-b-0 rounded-t-lg p-3 sm:p-6 pb-4 flex-1 mx-1 sm:mx-0">
            {activeTab === "config" && (
              <div className="grid grid-cols-2 xl:grid-cols-4 gap-x-2 gap-y-4 sm:gap-8 animate-in fade-in duration-200">
                {/* Audio Source */}
                <div>
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-[10px] text-zinc-500 font-bold tracking-widest uppercase line-clamp-1">
                      Fonte de Áudio
                    </h3>
                  </div>
                  <div className="grid grid-cols-2 gap-2 max-w-[180px] sm:max-w-[230px]">
                    {/* Local Mic */}
                    <button
                      onClick={handleSelectLocal}
                      className={`flex flex-col items-center justify-center p-1.5 rounded-xl border-2 transition-all text-center aspect-square relative ${
                        devices.some(
                          (d) =>
                            getDeviceCategory(d) === "local" &&
                            d.deviceId === selectedDeviceId,
                        )
                          ? "border-pink-500 bg-pink-500/10 text-pink-500 z-10 shadow-[0_0_8px_rgba(236,72,153,0.3)]"
                          : "border-zinc-800 bg-zinc-950/50 text-zinc-600 hover:border-pink-500/50 hover:text-pink-400"
                      }`}
                    >
                      <div className="mb-0.5">
                        <Mic size={15} />
                      </div>
                      <span className="text-[8px] sm:text-[9.5px] font-black tracking-tight leading-none uppercase">
                        Mic Local
                      </span>
                      {devices.some(
                        (d) =>
                          getDeviceCategory(d) === "local" &&
                          d.deviceId === selectedDeviceId,
                      ) && (
                        <div className="absolute top-1.5 right-1.5">
                          <div className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                        </div>
                      )}
                    </button>

                    {/* Bluetooth */}
                    <button
                      onClick={handleSelectBT}
                      className={`flex flex-col items-center justify-center p-1.5 rounded-xl border-2 transition-all text-center aspect-square relative ${
                        devices.some(
                          (d) =>
                            getDeviceCategory(d) === "bt" &&
                            d.deviceId === selectedDeviceId,
                        )
                          ? "border-blue-500 bg-blue-500/10 text-blue-500 z-10 shadow-[0_0_8px_rgba(59,130,246,0.3)]"
                          : "border-zinc-800 bg-zinc-950/50 text-zinc-600 hover:border-blue-500/50 hover:text-blue-400"
                      }`}
                    >
                      <div className="mb-0.5">
                        <Bluetooth size={15} />
                      </div>
                      <span className="text-[8px] sm:text-[9.5px] font-black tracking-tight leading-none uppercase">
                        Bluetooth
                      </span>
                      {devices.some(
                        (d) =>
                          getDeviceCategory(d) === "bt" &&
                          d.deviceId === selectedDeviceId,
                      ) && (
                        <div className="absolute top-1.5 right-1.5">
                          <div className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                        </div>
                      )}
                    </button>

                    {/* AUX */}
                    <button
                      onClick={handleSelectAUX}
                      className={`flex flex-col items-center justify-center p-1.5 rounded-xl border-2 transition-all text-center aspect-square relative ${
                        devices.some(
                          (d) =>
                            getDeviceCategory(d) === "aux" &&
                            d.deviceId === selectedDeviceId,
                        )
                          ? "border-violet-500 bg-violet-500/10 text-violet-500 z-10 shadow-[0_0_8px_rgba(139,92,246,0.3)]"
                          : "border-zinc-800 bg-zinc-950/50 text-zinc-600 hover:border-violet-500/50 hover:text-violet-400"
                      }`}
                    >
                      <div className="mb-0.5">
                        <Cable size={15} />
                      </div>
                      <span className="text-[8px] sm:text-[9.5px] font-black tracking-tight leading-none uppercase">
                        P2 / AUX
                      </span>
                      {devices.some(
                        (d) =>
                          getDeviceCategory(d) === "aux" &&
                          d.deviceId === selectedDeviceId,
                      ) && (
                        <div className="absolute top-1.5 right-1.5">
                          <div className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                        </div>
                      )}
                    </button>

                    {/* USB */}
                    <button
                      onClick={handleSelectUSB}
                      className={`flex flex-col items-center justify-center p-1.5 rounded-xl border-2 transition-all text-center aspect-square relative ${
                        devices.some(
                          (d) =>
                            getDeviceCategory(d) === "usb" &&
                            d.deviceId === selectedDeviceId,
                        )
                          ? "border-red-500 bg-red-500/10 text-red-500 z-10 shadow-[0_0_8px_rgba(239,68,68,0.3)]"
                          : "border-zinc-800 bg-zinc-950/50 text-zinc-650 hover:border-red-500/50 hover:text-red-400"
                      }`}
                    >
                      <div className="mb-0.5">
                        <Usb size={15} />
                      </div>
                      <span className="text-[8px] sm:text-[9.5px] font-black tracking-tight leading-none uppercase">
                        Interface
                      </span>
                      {devices.some(
                        (d) =>
                          getDeviceCategory(d) === "usb" &&
                          d.deviceId === selectedDeviceId,
                      ) && (
                        <div className="absolute top-1.5 right-1.5">
                          <div className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                        </div>
                      )}
                    </button>
                  </div>
                </div>

                {/* Output Format */}
                <div>
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-[10px] text-zinc-500 font-bold tracking-widest uppercase line-clamp-1">
                      Formato / Qualidade
                    </h3>
                  </div>
                  <div className="grid grid-cols-2 gap-2 max-w-[180px] sm:max-w-[230px]">
                    <button
                      onClick={() => setSelectedFormat("wav")}
                      className={`flex flex-col items-center justify-center p-1.5 rounded-xl border-2 transition-all text-center aspect-square ${
                        selectedFormat === "wav"
                          ? "border-amber-500 bg-amber-500/5 text-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.25)]"
                          : "border-zinc-800 bg-zinc-950/30 text-zinc-600 hover:border-zinc-700 hover:text-zinc-400"
                      }`}
                    >
                      <span className="text-[8px] sm:text-[9.5px] font-black tracking-widest uppercase">
                        WAV
                      </span>
                      <span className="text-[6.5px] sm:text-[7.5px] opacity-60 mt-1 font-medium">
                        Lossless
                      </span>
                    </button>

                    <button
                      onClick={() => setSelectedFormat("128k")}
                      className={`flex flex-col items-center justify-center p-1.5 rounded-xl border-2 transition-all text-center aspect-square ${
                        selectedFormat === "128k"
                          ? "border-emerald-500 bg-emerald-500/5 text-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.25)]"
                          : "border-zinc-800 bg-zinc-950/30 text-zinc-600 hover:border-zinc-700 hover:text-zinc-400"
                      }`}
                    >
                      <span className="text-[8px] sm:text-[9.5px] font-black tracking-widest uppercase">
                        128k
                      </span>
                      <span className="text-[6.5px] sm:text-[7.5px] opacity-60 mt-1 font-medium">
                        MP3 (Em breve)
                      </span>
                    </button>
                    <button
                      onClick={() => setSelectedFormat("256k")}
                      className={`flex flex-col items-center justify-center p-1.5 rounded-xl border-2 transition-all text-center aspect-square ${
                        selectedFormat === "256k"
                          ? "border-white bg-white/5 text-white shadow-[0_0_8px_rgba(255,255,255,0.25)]"
                          : "border-zinc-800 bg-zinc-950/30 text-zinc-600 hover:border-zinc-700 hover:text-zinc-400"
                      }`}
                    >
                      <span className="text-[8px] sm:text-[9.5px] font-black tracking-widest uppercase">
                        256k
                      </span>
                      <span className="text-[6.5px] sm:text-[7.5px] opacity-60 mt-1 font-medium">
                        MP3 (Em breve)
                      </span>
                    </button>
                    <button
                      onClick={() => setSelectedFormat("320k")}
                      className={`flex flex-col items-center justify-center p-1.5 rounded-xl border-2 transition-all text-center aspect-square ${
                        selectedFormat === "320k"
                          ? "border-rose-500 bg-rose-500/5 text-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.25)]"
                          : "border-zinc-800 bg-zinc-950/30 text-zinc-600 hover:border-zinc-700 hover:text-zinc-400"
                      }`}
                    >
                      <span className="text-[8px] sm:text-[9.5px] font-black tracking-widest uppercase">
                        320k
                      </span>
                      <span className="text-[6.5px] sm:text-[7.5px] opacity-60 mt-1 font-medium">
                        MP3 (Em breve)
                      </span>
                    </button>
                  </div>
                </div>

                {/* Channel Mode Settings */}
                <div>
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-[10px] text-zinc-500 font-bold tracking-widest uppercase line-clamp-1">
                      Modo de Canais
                    </h3>
                  </div>
                  <div className="grid grid-cols-2 gap-2 max-w-[180px] sm:max-w-[230px]">
                    <button
                      ref={gridButtonRef}
                      onClick={() => setChannelMode("dupe-left")}
                      className={`flex flex-col items-center justify-center p-1.5 rounded-xl border-2 transition-all text-center aspect-square relative ${
                        channelMode === "dupe-left"
                          ? "border-emerald-500 bg-emerald-500/5 text-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.25)]"
                          : "border-zinc-800 bg-zinc-950/30 text-zinc-600 hover:border-zinc-700 hover:text-zinc-400"
                      }`}
                      title="Grava mono/bluetooth no canal esquerdo e copia para o direito, equilibrando o som perfeitamente nos dois ouvidos e duplicando a força do sinal!"
                    >
                      <span className="text-[8px] sm:text-[9.5px] font-black tracking-widest uppercase leading-tight">
                        Mono Duplo
                      </span>
                      <span className="text-[6.5px] sm:text-[7.5px] opacity-70 mt-1 font-extrabold text-center leading-none">
                        Clone L ➔ R<br/>(Bluetooth/Mics)
                      </span>
                    </button>

                    <button
                      onClick={() => setChannelMode("stereo")}
                      className={`flex flex-col items-center justify-center p-1.5 rounded-xl border-2 transition-all text-center aspect-square relative ${
                        channelMode === "stereo"
                          ? "border-blue-500 bg-blue-500/5 text-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.25)]"
                          : "border-zinc-800 bg-zinc-950/30 text-zinc-600 hover:border-zinc-700 hover:text-zinc-400"
                      }`}
                      title="Grava os canais Esquerdo e Direito de forma independente (ideal para som ambiente ou instrumentos estéreo reais)."
                    >
                      <span className="text-[8px] sm:text-[9.5px] font-black tracking-widest uppercase leading-tight">
                        Estéreo Real
                      </span>
                      <span className="text-[6.5px] sm:text-[7.5px] opacity-70 mt-1 font-extrabold text-center leading-none">
                        L + R Separados<br/>(Multi-canal)
                      </span>
                    </button>
                  </div>
                  
                  {/* Pasta de Arquivos - Acesso Rápido a Gravações */}
                  <div className="mt-3 max-w-[180px] sm:max-w-[230px]">
                    <button
                      onClick={() => setActiveTab("recordings")}
                      className="w-full flex flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-amber-500/40 bg-amber-500/5 text-amber-500 hover:bg-amber-500/10 hover:border-amber-500 active:scale-[0.98] transition-all font-bold group cursor-pointer h-[86px] sm:h-[111px]"
                      style={buttonHeight ? { height: `${buttonHeight}px` } : undefined}
                      title="Pasta de Arquivos - Acesso rápido a gravações"
                    >
                      <FolderOpen size={18} className="text-amber-500 group-hover:scale-110 transition-transform" />
                      <span className="text-[8.5px] sm:text-[10px] font-black tracking-widest uppercase">
                        Gravações
                      </span>
                    </button>
                  </div>
                </div>

                {/* Amplifier Gain Settings */}
                <div>
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-[10px] text-zinc-500 font-bold tracking-widest uppercase line-clamp-1 flex items-center gap-1">
                      <Sliders size={12} className="text-zinc-400" />
                      Amplificador de Sinal
                    </h3>
                  </div>
                  <div className="grid grid-cols-2 gap-2 max-w-[180px] sm:max-w-[230px]">
                    <button
                      onClick={() => setExtraBoost(1.0)}
                      className={`flex flex-col items-center justify-center p-1.5 rounded-xl border-2 transition-all text-center aspect-square ${
                        extraBoost === 1.0
                          ? "border-zinc-300 bg-zinc-300/5 text-zinc-300 shadow-[0_0_8px_rgba(255,255,255,0.12)]"
                          : "border-zinc-800 bg-zinc-950/30 text-zinc-650 hover:border-zinc-700 hover:text-zinc-400"
                      }`}
                    >
                      <span className="text-[8px] sm:text-[9.5px] font-extrabold tracking-widest uppercase leading-none">
                        Normal
                      </span>
                      <span className="text-[6.5px] sm:text-[7.5px] opacity-60 mt-1 font-mono font-bold">
                        1x (0 dB)
                      </span>
                    </button>

                    <button
                      onClick={() => setExtraBoost(2.0)}
                      className={`flex flex-col items-center justify-center p-1.5 rounded-xl border-2 transition-all text-center aspect-square ${
                        extraBoost === 2.0
                          ? "border-amber-500 bg-amber-500/5 text-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.25)]"
                          : "border-zinc-800 bg-zinc-950/30 text-zinc-650 hover:border-zinc-700 hover:text-zinc-400"
                      }`}
                    >
                      <span className="text-[8px] sm:text-[9.5px] font-extrabold tracking-widest uppercase leading-none">
                        Boost x2
                      </span>
                      <span className="text-[6.5px] sm:text-[7.5px] opacity-60 mt-1 font-mono font-bold">
                        2x (+6 dB)
                      </span>
                    </button>

                    <button
                      onClick={() => setExtraBoost(4.0)}
                      className={`flex flex-col items-center justify-center p-1.5 rounded-xl border-2 transition-all text-center aspect-square ${
                        extraBoost === 4.0
                          ? "border-orange-500 bg-orange-500/5 text-orange-500 shadow-[0_0_8px_rgba(249,115,22,0.25)]"
                          : "border-zinc-800 bg-zinc-950/30 text-zinc-650 hover:border-zinc-700 hover:text-zinc-400"
                      }`}
                      title="Amplificação ideal recomendada para compensar a perda dinâmica de fones e adaptadores bluetooth"
                    >
                      <span className="text-[8px] sm:text-[9.5px] font-black tracking-tight leading-none text-orange-400 uppercase">
                        BOOST X4
                      </span>
                      <span className="text-[6.5px] sm:text-[7.5px] opacity-75 mt-1 font-bold leading-none text-orange-400/80 text-center">
                        Indicado para<br/>Bluetooth
                      </span>
                    </button>

                    <button
                      onClick={() => setExtraBoost(6.0)}
                      className={`flex flex-col items-center justify-center p-1.5 rounded-xl border-2 transition-all text-center aspect-square ${
                        extraBoost === 6.0
                          ? "border-rose-500 bg-rose-500/10 text-rose-500 shadow-[0_0_12px_rgba(244,63,94,0.3)]"
                          : "border-zinc-800 bg-zinc-950/30 text-zinc-650 hover:border-zinc-700 hover:text-zinc-400"
                      }`}
                    >
                      <span className="text-[8px] sm:text-[9.5px] font-extrabold tracking-widest uppercase text-rose-450 animate-pulse leading-none">
                        MÁXIMO
                      </span>
                      <span className="text-[6.5px] sm:text-[7.5px] opacity-60 mt-1 font-mono font-bold">
                        6x (+15.5dB)
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "recordings" && (
              <div className="space-y-3">
                {recordings.length === 0 ? (
                  <div className="text-center py-8 text-zinc-500 text-sm">
                    Nenhuma gravação recente na sessão atual. <br />
                    Grave algo e aparecerá aqui.
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between mb-2 px-1">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            if (
                              selectedLocalUrls.length === recordings.length
                            ) {
                              setSelectedLocalUrls([]);
                            } else {
                              setSelectedLocalUrls(
                                recordings.map((r) => r.url),
                              );
                            }
                          }}
                          className="text-[10px] font-bold text-zinc-400 hover:text-zinc-200 uppercase tracking-widest flex items-center gap-1"
                        >
                          {selectedLocalUrls.length === recordings.length ? (
                            <Square size={12} />
                          ) : (
                            <CheckCircle2
                              size={12}
                              className="text-amber-500"
                            />
                          )}
                          {selectedLocalUrls.length === recordings.length
                            ? "Desmarcar Tudo"
                            : "Marcar Tudo"}
                        </button>
                        <span className="text-[10px] text-zinc-600 font-bold">
                          ({selectedLocalUrls.length} selecionado)
                        </span>
                      </div>
                      {selectedLocalUrls.length > 0 && (
                        <button
                          onClick={bulkDeleteLocal}
                          className="text-[10px] font-bold text-red-500 hover:text-red-400 uppercase tracking-widest flex items-center gap-1"
                        >
                          <Trash2 size={12} />
                          Excluir Selecionados
                        </button>
                      )}
                    </div>

                    {recordings.map((rec, i) => {
                      const isSelected = selectedLocalUrls.includes(rec.url);
                      return (
                        <div
                          key={rec.url}
                          className={`flex flex-col sm:flex-row items-stretch sm:items-center justify-between p-3 lg:p-4 border rounded-lg gap-4 transition-all ${isSelected ? "bg-amber-500/5 border-amber-500/30" : "bg-zinc-950 border-zinc-800"}`}
                        >
                          <div className="flex items-center gap-3 flex-1">
                            <button
                              onClick={() => {
                                setSelectedLocalUrls((prev) =>
                                  prev.includes(rec.url)
                                    ? prev.filter((u) => u !== rec.url)
                                    : [...prev, rec.url],
                                );
                              }}
                              className={`shrink-0 h-5 w-5 rounded border transition-all flex items-center justify-center ${isSelected ? "bg-amber-500 border-amber-500 text-zinc-950" : "border-zinc-700 bg-zinc-900 text-transparent"}`}
                            >
                              <Check size={14} strokeWidth={4} />
                            </button>
                            <div className="flex flex-col flex-1">
                              <span className="text-sm font-bold text-zinc-200">
                                ÍsuAudio_Local_{recordings.length - i}.webm
                              </span>
                              <span className="text-xs text-zinc-500">
                                {rec.date.toLocaleTimeString()} -{" "}
                                {rec.date.toLocaleDateString()}
                              </span>
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <audio
                              controls
                              src={rec.url}
                              className="h-8 w-full sm:w-[200px] outline-none invert sepia hue-rotate-180 opacity-80"
                            />
                            <div className="flex gap-2 w-full sm:w-auto">
                              <a
                                href={rec.url}
                                download={`ÍsuAudio_Local_${recordings.length - i}.webm`}
                                className="flex-1 sm:flex-none px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] font-bold rounded transition-colors text-center"
                              >
                                BAIXAR
                              </a>
                              <button
                                onClick={() => uploadToCloud(rec)}
                                disabled={!!isUploading}
                                className={`flex-1 sm:flex-none px-3 py-1.5 rounded text-[10px] font-bold flex items-center justify-center gap-1 transition-all ${
                                  isUploading === rec.url
                                    ? "bg-amber-500/20 text-amber-500 animate-pulse"
                                    : "bg-amber-500 hover:bg-amber-400 text-zinc-950"
                                }`}
                              >
                                <UploadCloud size={14} />
                                {isUploading === rec.url
                                  ? "ENVIANDO..."
                                  : "SALVAR NA NUVEM"}
                              </button>
                              <button
                                onClick={() => uploadToGoogleDrive(rec)}
                                disabled={!!isUploadingToDrive}
                                className={`flex-1 sm:flex-none px-3 py-1.5 rounded text-[10px] font-bold flex items-center justify-center gap-1 transition-all ${
                                  isUploadingToDrive === rec.url
                                    ? "bg-emerald-500/20 text-emerald-500 animate-pulse"
                                    : "bg-emerald-600 hover:bg-emerald-500 text-white"
                                }`}
                              >
                                <HardDrive size={14} />
                                {isUploadingToDrive === rec.url
                                  ? "ENVIANDO..."
                                  : "SALVAR NO DRIVE"}
                              </button>
                              <button
                                onClick={() => deleteLocalRecording(rec.url)}
                                className="p-2 bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20 rounded transition-all"
                                title="Excluir"
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            )}

            {activeTab === "cloud" && (
              <div className="space-y-3">
                {!user ? (
                  <div className="text-center py-12">
                    <Cloud size={48} className="mx-auto text-zinc-700 mb-4" />
                    <p className="text-zinc-400 mb-6">
                      Faça login para gerenciar suas gravações na nuvem.
                    </p>
                    <button
                      onClick={handleGoogleLogin}
                      className="bg-amber-500 hover:bg-amber-400 text-zinc-950 px-6 py-2 rounded-lg font-bold transition-all"
                    >
                      Login com Google
                    </button>
                  </div>
                ) : cloudRecordings.length === 0 ? (
                  <div className="text-center py-12 text-zinc-500">
                    Você ainda não tem gravações na nuvem.
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between mb-2 px-1">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            if (
                              selectedCloudIds.length === cloudRecordings.length
                            ) {
                              setSelectedCloudIds([]);
                            } else {
                              setSelectedCloudIds(
                                cloudRecordings.map((r) => r.id),
                              );
                            }
                          }}
                          className="text-[10px] font-bold text-zinc-400 hover:text-zinc-200 uppercase tracking-widest flex items-center gap-1"
                        >
                          {selectedCloudIds.length ===
                          cloudRecordings.length ? (
                            <Square size={12} />
                          ) : (
                            <CheckCircle2
                              size={12}
                              className="text-amber-500"
                            />
                          )}
                          {selectedCloudIds.length === cloudRecordings.length
                            ? "Desmarcar Tudo"
                            : "Marcar Tudo"}
                        </button>
                        <span className="text-[10px] text-zinc-600 font-bold">
                          ({selectedCloudIds.length} selecionado)
                        </span>
                      </div>
                      {selectedCloudIds.length > 0 && (
                        <button
                          onClick={bulkDeleteCloud}
                          className="text-[10px] font-bold text-red-500 hover:text-red-400 uppercase tracking-widest flex items-center gap-1"
                        >
                          <Trash2 size={12} />
                          Excluir Selecionados
                        </button>
                      )}
                    </div>

                    {cloudRecordings.map((rec) => {
                      const isSelected = selectedCloudIds.includes(rec.id);
                      return (
                        <div
                          key={rec.id}
                          className={`flex flex-col sm:flex-row items-stretch sm:items-center justify-between p-3 lg:p-4 border rounded-lg gap-4 transition-all ${isSelected ? "bg-amber-500/5 border-amber-500/30" : "bg-zinc-950 border-zinc-800"}`}
                        >
                          <div className="flex items-center gap-3 flex-1">
                            <button
                              onClick={() => {
                                setSelectedCloudIds((prev) =>
                                  prev.includes(rec.id)
                                    ? prev.filter((id) => id !== rec.id)
                                    : [...prev, rec.id],
                                );
                              }}
                              className={`shrink-0 h-5 w-5 rounded border transition-all flex items-center justify-center ${isSelected ? "bg-amber-500 border-amber-500 text-zinc-950" : "border-zinc-700 bg-zinc-900 text-transparent"}`}
                            >
                              <Check size={14} strokeWidth={4} />
                            </button>
                            <div className="flex flex-col flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-bold text-zinc-200">
                                  {rec.title}
                                </span>
                                {rec.isPublic && (
                                  <span className="text-[8px] bg-emerald-500/10 text-emerald-500 px-1.5 py-0.5 rounded border border-emerald-500/20 font-bold uppercase tracking-wider">
                                    Público
                                  </span>
                                )}
                              </div>
                              <span className="text-xs text-zinc-500">
                                {rec.createdAt?.toDate
                                  ? rec.createdAt.toDate().toLocaleString()
                                  : "Enviando..."}
                              </span>
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <audio
                              controls
                              src={rec.audioData}
                              className="h-8 w-full sm:w-[150px] outline-none invert sepia hue-rotate-180 opacity-80"
                            />
                            <div className="flex gap-2 w-full sm:w-auto">
                              <button
                                onClick={() =>
                                  toggleShare(rec.id, rec.isPublic)
                                }
                                className={`p-2 rounded transition-all ${rec.isPublic ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "bg-zinc-800 text-zinc-400 border border-zinc-700"}`}
                                title={rec.isPublic ? "Privar" : "Compartilhar"}
                              >
                                <Share2 size={16} />
                              </button>
                              {rec.isPublic && (
                                <button
                                  onClick={() => copyShareLink(rec.id)}
                                  className="p-2 bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded"
                                  title="Copiar Link"
                                >
                                  <CheckCircle2 size={16} />
                                </button>
                              )}
                              <button
                                onClick={() => deleteCloudRecording(rec.id)}
                                className="p-2 bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20 rounded transition-all"
                                title="Excluir"
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            )}

            {activeTab === "drive" && (
              <div className="space-y-3">
                {!user || !driveAccessToken ? (
                  <div className="text-center py-12 bg-zinc-950/40 rounded-xl border border-zinc-800/80 p-6">
                    <HardDrive
                      size={48}
                      className="mx-auto text-emerald-500 mb-4 animate-pulse"
                    />
                    <h3 className="text-zinc-200 font-bold text-sm mb-1 uppercase tracking-widest">
                      Acesso ao Google Drive
                    </h3>
                    <p className="text-zinc-500 text-[11px] max-w-xs mx-auto mb-6 leading-relaxed">
                      Conecte sua conta do Google para salvar, pesquisar e
                      reproduzir seus arquivos de áudio diretamente do seu Drive
                      com sua permissão.
                    </p>
                    <button
                      onClick={handleGoogleLogin}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-2 rounded-lg font-black text-[10px] tracking-widest uppercase transition-all shadow-[0_0_15px_rgba(16,185,129,0.3)] cursor-pointer"
                    >
                      Conectar Google Drive
                    </button>
                  </div>
                ) : (
                  <>
                    {/* Google Drive Folder Selector Bar */}
                    <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between bg-zinc-950 p-2.5 rounded-lg border border-emerald-500/10 shadow-[0_0_15px_rgba(16,185,129,0.03)]">
                      <div className="flex items-center gap-2">
                        <div className="p-1 px-2 bg-emerald-500/10 text-emerald-400 rounded border border-emerald-500/20">
                          <Folder size={14} />
                        </div>
                        <div className="flex flex-col leading-none">
                          <span className="text-[8px] text-zinc-500 font-bold uppercase tracking-widest font-mono">Pasta de Gravação</span>
                          <span className="text-xs font-bold text-zinc-100 mt-0.5">
                            {targetDriveFolder ? (
                              <span className="flex items-center gap-1 text-emerald-400 font-extrabold">
                                {targetDriveFolder.name} 
                              </span>
                            ) : (
                              <span className="text-zinc-400 italic font-medium">Raiz do Google Drive</span>
                            )}
                          </span>
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-2">
                        {targetDriveFolder && (
                          <div className="flex items-center gap-1.5 bg-zinc-900/50 px-2 py-1 rounded border border-zinc-805">
                            <input 
                              type="checkbox"
                              id="showOnlyFolderFilesToggle"
                              checked={showOnlyFolderFiles}
                              onChange={(e) => setShowOnlyFolderFiles(e.target.checked)}
                              className="rounded border-zinc-700 text-emerald-500 focus:ring-emerald-500 h-3 w-3 bg-zinc-950 accent-emerald-500 cursor-pointer"
                            />
                            <label htmlFor="showOnlyFolderFilesToggle" className="text-[8px] font-black text-zinc-400 select-none cursor-pointer uppercase tracking-wider font-mono">
                              Apenas nesta pasta
                            </label>
                          </div>
                        )}
                        <button
                          onClick={() => setShowFolderModal(true)}
                          className="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white rounded text-[9px] font-black uppercase tracking-widest transition-all cursor-pointer flex items-center justify-center gap-1 shadow-[0_0_10px_rgba(16,185,129,0.15)]"
                        >
                          <FolderOpen size={10} />
                          Escolher Pasta
                        </button>
                        {targetDriveFolder && (
                          <button
                            onClick={() => {
                              if (window.confirm("Deseja salvar novas gravações na raiz do Google Drive?")) {
                                setTargetDriveFolder(null);
                              }
                            }}
                            className="px-2 py-1.5 bg-zinc-900 border border-zinc-800 hover:border-red-500/30 hover:bg-red-500/5 text-zinc-400 hover:text-red-400 rounded text-[9px] font-bold uppercase tracking-widest transition-all cursor-pointer"
                            title="Voltar para a Raiz"
                          >
                            Limpar
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Inline Quick Folder Creation Banner when targetDriveFolder is not set */}
                    {!targetDriveFolder && (
                      <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-3 flex flex-col sm:flex-row items-center justify-between gap-3 animate-in fade-in duration-200">
                        <div className="flex items-center gap-2">
                          <FolderPlus className="text-emerald-400 shrink-0" size={18} />
                          <div className="text-left leading-tight">
                            <h4 className="text-xs font-bold text-zinc-200">Criar uma pasta dedicada no Drive?</h4>
                            <p className="text-[10px] text-zinc-450">Organize suas novas gravações em uma pasta exclusiva em seu Google Drive.</p>
                          </div>
                        </div>
                        <button
                          onClick={async () => {
                            const folderName = window.prompt("Digite o nome da pasta no Google Drive para as gravações:", "Minhas Gravações ÍSU");
                            if (folderName && folderName.trim()) {
                              await createDriveFolder(folderName);
                            }
                          }}
                          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white rounded text-[9.5px] font-black uppercase tracking-widest transition-all cursor-pointer shadow-[0_0_10px_rgba(16,185,129,0.2)] flex items-center gap-1 shrink-0"
                        >
                          <FolderPlus size={12} />
                          Criar Pasta de Gravações
                        </button>
                      </div>
                    )}

                    {/* Search and Action Bar */}
                    <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between bg-zinc-950 p-2.5 rounded-lg border border-zinc-800">
                      <div className="relative flex-1">
                        <Search
                          className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500"
                          size={14}
                        />
                        <input
                          type="text"
                          placeholder="Pesquisar áudios no Google Drive..."
                          value={driveSearch}
                          onChange={(e) => setDriveSearch(e.target.value)}
                          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-9 pr-3 py-1.5 text-zinc-100 text-xs focus:outline-none focus:border-emerald-500 transition-colors"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => loadDriveFiles()}
                          disabled={isDriveLoading}
                          className="p-1.5 bg-zinc-800 hover:bg-zinc-700 hover:text-emerald-400 text-zinc-300 rounded border border-zinc-700 transition-colors flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest cursor-pointer"
                        >
                          <RefreshCw
                            size={12}
                            className={isDriveLoading ? "animate-spin" : ""}
                          />
                          {isDriveLoading ? "Buscando..." : "Atualizar"}
                        </button>
                      </div>
                    </div>

                    {isDriveLoading && googleDriveFiles.length === 0 ? (
                      <div className="text-center py-12 text-zinc-500 text-xs font-bold uppercase tracking-widest animate-pulse font-mono">
                        Carregando arquivos de áudio do seu Drive...
                      </div>
                    ) : googleDriveFiles.length > 0 &&
                      googleDriveFiles.filter((f) =>
                        f.name
                          .toLowerCase()
                          .includes(driveSearch.toLowerCase()),
                      ).length === 0 ? (
                      <div className="text-center py-12 bg-zinc-950/20 border border-zinc-805/30 rounded-xl text-zinc-500 text-xs">
                        Nenhum arquivo correspondente encontrado no seu Google
                        Drive.
                      </div>
                    ) : googleDriveFiles.length === 0 ? (
                      <div className="text-center py-12 bg-zinc-950/20 border border-zinc-850/30 rounded-xl text-zinc-500 text-xs font-mono leading-relaxed p-4">
                        Nenhum arquivo de áudio (.webm, .wav, .mp3, .m4a)
                        encontrado no Google Drive. <br />
                        Grave um áudio local e use o botão "SALVAR NO DRIVE"!
                      </div>
                    ) : (
                      <>
                        {/* Bulk operations bar */}
                        <div className="flex items-center justify-between mb-2 px-1">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => {
                                const filtered = googleDriveFiles.filter((f) =>
                                  f.name
                                    .toLowerCase()
                                    .includes(driveSearch.toLowerCase()),
                                );
                                if (
                                  selectedDriveIds.length === filtered.length
                                ) {
                                  setSelectedDriveIds([]);
                                } else {
                                  setSelectedDriveIds(
                                    filtered.map((r) => r.id),
                                  );
                                }
                              }}
                              className="text-[10px] font-bold text-zinc-400 hover:text-zinc-200 uppercase tracking-widest flex items-center gap-1 cursor-pointer"
                            >
                              {selectedDriveIds.length ===
                              googleDriveFiles.filter((f) =>
                                f.name
                                  .toLowerCase()
                                  .includes(driveSearch.toLowerCase()),
                              ).length ? (
                                <Square size={12} />
                              ) : (
                                <CheckCircle2
                                  size={12}
                                  className="text-emerald-500"
                                />
                              )}
                              {selectedDriveIds.length ===
                              googleDriveFiles.filter((f) =>
                                f.name
                                  .toLowerCase()
                                  .includes(driveSearch.toLowerCase()),
                              ).length
                                ? "Desmarcar Tudo"
                                : "Marcar Tudo"}
                            </button>
                            <span className="text-[10px] text-zinc-600 font-bold">
                              ({selectedDriveIds.length} selecionado)
                            </span>
                          </div>
                          {selectedDriveIds.length > 0 && (
                            <button
                              onClick={bulkDeleteDrive}
                              className="text-[10px] font-bold text-red-500 hover:text-red-400 uppercase tracking-widest flex items-center gap-1"
                            >
                              <Trash2 size={12} />
                              Excluir Selecionados
                            </button>
                          )}
                        </div>

                        {/* Files list */}
                        <div className="space-y-2">
                          {googleDriveFiles
                            .filter((f) =>
                              f.name
                                .toLowerCase()
                                .includes(driveSearch.toLowerCase()),
                            )
                            .map((rec) => {
                              const isSelected = selectedDriveIds.includes(
                                rec.id,
                              );
                              const fileSizeBytes = rec.size
                                ? Number(rec.size)
                                : 0;
                              const sizeString = fileSizeBytes
                                ? (fileSizeBytes / (1024 * 1024)).toFixed(2) +
                                  " MB"
                                : "Vago";
                              const createdDate = rec.createdTime
                                ? new Date(rec.createdTime).toLocaleString()
                                : "Sem data";

                              return (
                                <div
                                  key={rec.id}
                                  className={`flex flex-col sm:flex-row items-stretch sm:items-center justify-between p-3 lg:p-4 border rounded-lg gap-4 transition-all ${isSelected ? "bg-emerald-500/5 border-emerald-500/30 font-bold" : "bg-zinc-950 border-zinc-800"}`}
                                >
                                  <div className="flex items-center gap-3 flex-1 min-w-0">
                                    <button
                                      onClick={() => {
                                        setSelectedDriveIds((prev) =>
                                          prev.includes(rec.id)
                                            ? prev.filter((id) => id !== rec.id)
                                            : [...prev, rec.id],
                                        );
                                      }}
                                      className={`shrink-0 h-5 w-5 rounded border transition-all flex items-center justify-center ${isSelected ? "bg-emerald-500 border-emerald-500 text-zinc-950" : "border-zinc-700 bg-zinc-900 text-transparent"}`}
                                    >
                                      <Check size={14} strokeWidth={4} />
                                    </button>
                                    <div className="flex flex-col flex-1 min-w-0">
                                      <span className="text-sm font-bold text-zinc-200 truncate">
                                        {rec.name}
                                      </span>
                                      <span className="text-xs text-zinc-500 mt-1 font-mono">
                                        {createdDate} — {sizeString}
                                      </span>
                                    </div>
                                  </div>
                                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                                    {currentlyPlayingDriveFile === rec.id &&
                                    driveAudioUrl ? (
                                      <audio
                                        controls
                                        autoPlay
                                        src={driveAudioUrl}
                                        className="h-8 w-full sm:w-[220px] outline-none invert sepia hue-rotate-180 opacity-90"
                                      />
                                    ) : null}

                                    <div className="flex gap-2 w-full sm:w-auto justify-end">
                                      <button
                                        onClick={() => playDriveFile(rec.id)}
                                        className={`px-3 py-1.5 rounded text-[10px] font-bold flex items-center gap-1 transition-colors cursor-pointer ${
                                          currentlyPlayingDriveFile === rec.id
                                            ? "bg-red-500/20 text-red-500 border border-red-500/30"
                                            : "bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                                        }`}
                                      >
                                        {currentlyPlayingDriveFile ===
                                        rec.id ? (
                                          <Square size={12} />
                                        ) : (
                                          <Play size={12} />
                                        )}
                                        {currentlyPlayingDriveFile === rec.id
                                          ? "PARAR"
                                          : "REPRODUZIR"}
                                      </button>

                                      <button
                                        onClick={() =>
                                          deleteDriveFile(rec.id, rec.name)
                                        }
                                        className="p-2 bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20 rounded transition-all cursor-pointer"
                                        title="Excluir do Google Drive"
                                      >
                                        <Trash2 size={16} />
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          <div className="flex border border-t-0 border-zinc-800 shrink-0 bg-zinc-950/80 rounded-b-lg mx-1 sm:mx-0 overflow-x-auto custom-scrollbar">
            <button
              onClick={() => setActiveTab("config")}
              className={`flex-1 min-w-[70px] sm:min-w-[100px] flex items-center justify-center py-3 px-1 sm:px-2 text-[8px] sm:text-[10px] font-bold tracking-widest uppercase transition-colors border-t-2 ${
                activeTab === "config"
                  ? "border-amber-500 text-amber-500 bg-amber-500/5"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <Settings size={12} className="mr-1.5 shrink-0" />{" "}
              <span className="truncate">Opções</span>
            </button>
            <button
              onClick={() => setActiveTab("recordings")}
              className={`flex-1 min-w-[70px] sm:min-w-[100px] flex items-center justify-center py-3 px-1 sm:px-2 text-[8px] sm:text-[10px] font-bold tracking-widest uppercase transition-colors border-t-2 ${
                activeTab === "recordings"
                  ? "border-amber-500 text-amber-500 bg-amber-500/5"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <ListVideo size={12} className="mr-1.5 shrink-0" />{" "}
              <span className="truncate">Local ({recordings.length})</span>
            </button>
            <button
              onClick={() => setActiveTab("cloud")}
              className={`flex-1 min-w-[70px] sm:min-w-[100px] flex items-center justify-center py-3 px-1 sm:px-2 text-[8px] sm:text-[10px] font-bold tracking-widest uppercase transition-colors border-t-2 ${
                activeTab === "cloud"
                  ? "border-amber-500 text-amber-500 bg-amber-500/5"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <Cloud size={12} className="mr-1.5 shrink-0" />{" "}
              <span className="truncate">Nuvem ({cloudRecordings.length})</span>
            </button>
            <button
              onClick={() => setActiveTab("drive")}
              className={`flex-1 min-w-[85px] sm:min-w-[120px] flex items-center justify-center py-3 px-1 sm:px-2 text-[8px] sm:text-[10px] font-bold tracking-widest uppercase transition-colors border-t-2 ${
                activeTab === "drive"
                  ? "border-amber-500 text-amber-500 bg-emerald-500/5"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <HardDrive
                size={12}
                className="mr-1.5 text-emerald-400 shrink-0"
              />{" "}
              <span className="truncate">
                Google Drive (
                {user && driveAccessToken ? googleDriveFiles.length : "Off"})
              </span>
            </button>
          </div>
        </div>

        {/* Global Bottom Status Bar */}
        <div className="px-4 sm:px-6 py-3 bg-zinc-950/90 border-t border-zinc-800/50 sticky bottom-0 z-30 backdrop-blur-xl mt-auto animate-in fade-in duration-350">
          <div className="flex items-center justify-between space-x-4 max-w-xl mx-auto">
            {user ? (
              <div className="flex items-center space-x-3">
                <div className="text-left hidden sm:block">
                  <p className="text-[10px] text-zinc-300 font-bold leading-none">
                    {user.displayName}
                  </p>
                  <p className="text-[8px] text-zinc-500 leading-none mt-1">
                    {user.email}
                  </p>
                </div>
                <button
                  onClick={handleLogout}
                  className="flex items-center space-x-2 text-zinc-400 hover:text-zinc-100 transition-colors py-0.5"
                  title="Sair"
                >
                  <LogOut size={14} />
                </button>
              </div>
            ) : (
              <button
                onClick={handleGoogleLogin}
                className="flex items-center space-x-1.5 bg-zinc-800 hover:bg-zinc-700 px-2 py-1 rounded transition-colors text-zinc-100 text-[10px] uppercase font-bold"
              >
                <LogIn size={12} />
                <span>Login</span>
              </button>
            )}

            <div className="flex items-center gap-4">
              {devices.length === 0 && (
                <div className="flex flex-col items-end">
                  <button
                    onClick={initAudio}
                    className="text-[10px] uppercase bg-zinc-800 hover:bg-zinc-700 px-2 py-1 rounded transition-colors text-amber-500 flex items-center gap-1.5 font-medium"
                  >
                    <Mic size={12} /> Permitir Microfone
                  </button>
                  {permissionError && (
                    <p className="text-[8px] text-red-500 mt-0.5 max-w-[150px] text-right font-medium leading-none">
                      {permissionError}
                    </p>
                  )}
                </div>
              )}
              <div className="text-[9px] font-bold text-zinc-400 tracking-wider flex flex-col items-end">
                <div className="flex items-center">
                  <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full mr-1.5 shadow-[0_0_8px_rgba(16,185,129,0.5)]"></span>
                  ONLINE
                </div>
                {devices.length > 0 && (
                  <span className="text-[7.5px] text-zinc-500 mt-0.5 uppercase tracking-tighter max-w-[120px] truncate leading-none">
                    {devices.find((d) => d.deviceId === selectedDeviceId)
                      ?.label || "Dispositivo Padrão"}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Shared Recording Overlay */}
      {sharedRecording && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-zinc-950/90 backdrop-blur-sm animate-in fade-in duration-300">
          <div className="bg-zinc-900 border border-amber-500/50 rounded-2xl p-6 sm:p-8 max-w-md w-full shadow-[0_0_50px_rgba(245,158,11,0.2)]">
            <div className="flex justify-between items-start mb-6">
              <div>
                <h2 className="text-amber-500 font-black tracking-widest uppercase text-xl mb-1">
                  Áudio Compartilhado
                </h2>
                <p className="text-zinc-500 text-xs font-bold font-mono tracking-wider">
                  {sharedRecording.title}
                </p>
              </div>
              <button
                onClick={() => setSharedRecording(null)}
                className="text-zinc-500 hover:text-zinc-100 transition-colors"
              >
                <Square size={20} />
              </button>
            </div>

            <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 mb-6">
              <audio
                controls
                src={sharedRecording.audioData}
                className="w-full invert sepia hue-rotate-180"
              />
            </div>

            <div className="flex flex-col gap-3">
              <a
                href={sharedRecording.audioData}
                download={`${sharedRecording.title}.webm`}
                className="w-full bg-amber-500 hover:bg-amber-400 text-zinc-950 font-black py-3 rounded-lg text-center transition-all tracking-widest uppercase text-sm"
              >
                Baixar Gravação
              </a>
              <button
                onClick={() => setSharedRecording(null)}
                className="w-full bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-bold py-2 rounded-lg text-sm transition-all"
              >
                Fechar
              </button>
            </div>

            <p className="text-[10px] text-zinc-600 mt-6 text-center uppercase tracking-[0.2em] font-bold">
              Processado por ÍsuÁudio Professional
            </p>
          </div>
        </div>
      )}

      {/* Target Drive Folder Selection Modal */}
      {showFolderModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-zinc-950/90 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-zinc-950 border border-zinc-800 rounded-2xl w-full max-w-md shadow-[0_0_50px_rgba(16,185,129,0.15)] flex flex-col max-h-[90vh] overflow-hidden animate-in zoom-in-95 duration-150">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-zinc-900 bg-zinc-900/10">
              <div className="flex items-center gap-2">
                <FolderOpen className="text-emerald-500" size={18} />
                <h3 className="text-zinc-200 font-extrabold text-xs uppercase tracking-widest leading-none">Pasta de Destino</h3>
              </div>
              <button
                onClick={() => setShowFolderModal(false)}
                className="p-1.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 text-zinc-500 hover:text-zinc-300 rounded-lg transition-all"
              >
                <X size={14} />
              </button>
            </div>

            {/* Folder creation form */}
            <div className="p-4 bg-zinc-900/10 border-b border-zinc-900 flex flex-col gap-2">
              <span className="text-[9px] text-zinc-500 font-bold uppercase tracking-widest font-mono">Nova Pasta no Google Drive</span>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  createDriveFolder(newFolderName);
                }}
                className="flex gap-2"
              >
                <input
                  type="text"
                  placeholder="Nome de pasta (Ex: Gravações Radio)..."
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  disabled={isCreatingFolder}
                  className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-100 text-xs focus:outline-none focus:border-emerald-500 transition-colors placeholder:text-zinc-600"
                />
                <button
                  type="submit"
                  disabled={isCreatingFolder || !newFolderName.trim()}
                  className="px-3 bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-905 disabled:text-zinc-600 text-white rounded-lg text-[9px] font-black uppercase tracking-widest transition-all cursor-pointer flex items-center justify-center gap-1 shrink-0"
                >
                  {isCreatingFolder ? (
                    <RefreshCw size={12} className="animate-spin" />
                  ) : (
                    <FolderPlus size={12} />
                  )}
                  Criar
                </button>
              </form>
            </div>

            {/* Folder Search Filter */}
            <div className="relative px-4 pt-3 pb-1">
              <Search className="absolute left-7 top-[21px] -translate-y-1/2 text-zinc-600" size={12} />
              <input
                type="text"
                placeholder="Filtrar pastas existentes..."
                value={folderSearchText}
                onChange={(e) => setFolderSearchText(e.target.value)}
                className="w-full bg-zinc-900/60 border border-zinc-805 rounded-lg pl-8 pr-2.5 py-1.5 text-zinc-200 text-[11px] focus:outline-none focus:border-emerald-500/20 transition-colors"
              />
            </div>

            {/* Folders List selection */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2 max-h-[300px] min-h-[150px] custom-scrollbar">
              <button
                onClick={() => {
                  setTargetDriveFolder(null);
                  setShowFolderModal(false);
                }}
                className={`w-full text-left p-2 rounded-lg border text-[11px] transition-all flex items-center gap-2 active:scale-[0.99] ${
                  targetDriveFolder === null
                    ? "bg-emerald-500/10 border-emerald-500 text-emerald-400 font-extrabold"
                    : "bg-zinc-900/40 border-zinc-805 hover:bg-zinc-800 hover:border-zinc-700 text-zinc-300"
                }`}
              >
                <HardDrive size={14} className={targetDriveFolder === null ? "text-emerald-400 animate-pulse" : "text-zinc-500"} />
                <span className="truncate flex-1 font-bold">Raiz do Google Drive (Meu Drive)</span>
                {targetDriveFolder === null && <span className="bg-emerald-400/15 text-emerald-400 font-mono text-[8px] tracking-wide uppercase px-1.5 py-0.5 rounded border border-emerald-400/20 font-black">Ativo</span>}
              </button>

              {isFoldersLoading ? (
                <div className="py-8 text-center text-zinc-500 text-[10px] font-bold uppercase tracking-widest font-mono animate-pulse">
                  Processando pastas do Drive...
                </div>
              ) : driveFolders.length === 0 ? (
                <div className="py-8 text-center text-zinc-600 text-[11px] italic">
                  Nenhuma pasta extra encontrada no seu Google Drive. Use a caixa de texto acima para criar uma!
                </div>
              ) : (
                driveFolders
                  .filter((f) => f.name.toLowerCase().includes(folderSearchText.toLowerCase()))
                  .map((folder) => {
                    const isSelected = targetDriveFolder?.id === folder.id;
                    return (
                      <button
                        key={folder.id}
                        onClick={() => {
                          setTargetDriveFolder({ id: folder.id, name: folder.name });
                          setShowFolderModal(false);
                        }}
                        className={`w-full text-left p-2 rounded-lg border text-[11px] transition-all flex items-center gap-2 active:scale-[0.99] ${
                          isSelected
                            ? "bg-emerald-500/10 border-emerald-500 text-emerald-400 font-extrabold"
                            : "bg-zinc-900/40 border-zinc-805 hover:bg-zinc-800 hover:border-zinc-700 text-zinc-300"
                        }`}
                      >
                        <Folder size={14} className={isSelected ? "text-emerald-400" : "text-zinc-500"} />
                        <span className="truncate flex-1 font-bold">{folder.name}</span>
                        {isSelected && <span className="bg-emerald-400/15 text-emerald-400 font-mono text-[8px] tracking-wide uppercase px-1.5 py-0.5 rounded border border-emerald-400/20 font-black">Ativo</span>}
                      </button>
                    );
                  })
              )}
            </div>

            {/* Footer */}
            <div className="p-3 border-t border-zinc-900 bg-zinc-900/10 flex justify-end">
              <button
                onClick={() => setShowFolderModal(false)}
                className="px-4 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded font-black text-[9px] tracking-widest uppercase transition-colors"
              >
                Voltar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
