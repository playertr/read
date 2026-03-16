<script lang="ts">
  interface Props {
    isPlaying: boolean;
    speed: number;
    voice: string;
    voices: string[];
    currentSentence: number;
    totalSentences: number;
    isLoading: boolean;
    onplayclick?: () => void;
    onspeedchange?: (speed: number) => void;
    onvoicechange?: (voice: string) => void;
  }

  let {
    isPlaying,
    speed,
    voice,
    voices,
    currentSentence,
    totalSentences,
    isLoading,
    onplayclick,
    onspeedchange,
    onvoicechange,
  }: Props = $props();

  let visible = $state(true);
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  function resetHideTimer() {
    visible = true;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      visible = false;
    }, 3000);
  }

  // Start the auto-hide timer on mount
  $effect(() => {
    resetHideTimer();
  });

  function handleMouseMove() {
    resetHideTimer();
  }

  function handleSpeedInput(e: Event) {
    const target = e.target as HTMLInputElement;
    onspeedchange?.(parseFloat(target.value));
  }

  function handleVoiceChange(e: Event) {
    const target = e.target as HTMLSelectElement;
    onvoicechange?.(target.value);
  }
</script>

<svelte:window onmousemove={handleMouseMove} />

<div class="controls-bar" class:hidden={!visible}>
  {#if isLoading}
    <div class="loading">
      <div class="spinner"></div>
      <span>Loading TTS model…</span>
    </div>
  {:else}
    <button class="play-btn" onclick={onplayclick} aria-label={isPlaying ? 'Pause' : 'Play'}>
      {#if isPlaying}
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
          <rect x="6" y="4" width="4" height="16" rx="1" />
          <rect x="14" y="4" width="4" height="16" rx="1" />
        </svg>
      {:else}
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
          <path d="M8 5v14l11-7z" />
        </svg>
      {/if}
    </button>

    <div class="speed-control">
      <label for="speed-slider">Speed</label>
      <input
        id="speed-slider"
        type="range"
        min="0.5"
        max="3"
        step="0.1"
        value={speed}
        oninput={handleSpeedInput}
      />
      <span class="speed-label">{speed.toFixed(1)}×</span>
    </div>

    <div class="voice-control">
      <label for="voice-select">Voice</label>
      <select id="voice-select" value={voice} onchange={handleVoiceChange}>
        {#each voices as v}
          <option value={v}>{v}</option>
        {/each}
      </select>
    </div>

    <div class="sentence-counter">
      {currentSentence} / {totalSentences}
    </div>
  {/if}
</div>

<style>
  .controls-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 10px 20px;
    background: rgba(24, 24, 28, 0.88);
    backdrop-filter: blur(12px);
    color: #e0e0e0;
    font-size: 0.9rem;
    z-index: 1000;
    transition: transform 0.3s ease, opacity 0.3s ease;
  }

  .controls-bar.hidden {
    transform: translateY(100%);
    opacity: 0;
    pointer-events: none;
  }

  .loading {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    justify-content: center;
    padding: 4px 0;
  }

  .spinner {
    width: 20px;
    height: 20px;
    border: 2px solid rgba(255, 255, 255, 0.2);
    border-top-color: #7eb8ff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .play-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border: none;
    border-radius: 50%;
    background: #4a9eff;
    color: white;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s;
  }

  .play-btn:hover {
    background: #3a8eef;
  }

  .speed-control {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .speed-control label {
    font-size: 0.8rem;
    opacity: 0.7;
    white-space: nowrap;
  }

  .speed-control input[type='range'] {
    width: 100px;
    accent-color: #4a9eff;
  }

  .speed-label {
    min-width: 36px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  .voice-control {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .voice-control label {
    font-size: 0.8rem;
    opacity: 0.7;
    white-space: nowrap;
  }

  .voice-control select {
    background: rgba(255, 255, 255, 0.1);
    color: #e0e0e0;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .voice-control select option {
    background: #2a2a2e;
    color: #e0e0e0;
  }

  .sentence-counter {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    opacity: 0.7;
    font-size: 0.85rem;
    white-space: nowrap;
  }
</style>
