<script lang="ts">
  import { PDFViewer as EmbedPDFViewer } from '@embedpdf/svelte-pdf-viewer';
  import type { PluginRegistry, EmbedPdfContainer } from '@embedpdf/svelte-pdf-viewer';

  interface Props {
    /** URL or blob URL of the PDF to display. */
    src: string | null;
    /** Fired when the plugin registry is ready. */
    onregistryready?: (registry: PluginRegistry) => void;
  }

  let { src, onregistryready }: Props = $props();

  let container: EmbedPdfContainer | null = $state(null);

  function handleInit(c: EmbedPdfContainer) {
    container = c;
  }

  function handleReady(registry: PluginRegistry) {
    onregistryready?.(registry);
  }
</script>

{#if src}
  <div class="viewer-wrapper">
    <EmbedPDFViewer
      config={{
        src,
        theme: { preference: 'dark' },
        disabledCategories: ['annotation', 'redaction', 'print', 'export'],
      }}
      style="width: 100%; height: 100%;"
      oninit={handleInit}
      onready={handleReady}
    />
  </div>
{/if}

<style>
  .viewer-wrapper {
    width: 100%;
    height: 100%;
    position: relative;
  }
</style>
