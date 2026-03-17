<script lang="ts">
  import { PDFViewer as EmbedPDFViewer } from '@embedpdf/svelte-pdf-viewer';
  import type { PluginRegistry, EmbedPdfContainer } from '@embedpdf/svelte-pdf-viewer';

  interface Props {
    /** URL or blob URL of the PDF to display. */
    src: string | null;
    /** Fired when the plugin registry is ready. */
    onregistryready?: (registry: PluginRegistry) => void;
    /** Fired when user selects text (for "play from here"). */
    onsentenceclick?: (event: { text: string; pageIndex: number }) => void;
  }

  let { src, onregistryready, onsentenceclick }: Props = $props();

  let container: EmbedPdfContainer | null = $state(null);

  function handleInit(c: EmbedPdfContainer) {
    container = c;
  }

  function handleReady(registry: PluginRegistry) {
    onregistryready?.(registry);

    // Hook up text selection for "play from here"
    if (onsentenceclick) {
      const selection = registry.getPlugin('selection');
      if (selection) {
        const cap = selection as any;
        if (cap.onSelectionChange) {
          cap.onSelectionChange((event: any) => {
            if (event.selection) {
              const startPage = event.selection.start.page;
              cap.getSelectedText?.(event.documentId)?.toPromise?.().then((texts: string[]) => {
                const text = texts.join(' ').trim();
                if (text) {
                  onsentenceclick!({ text, pageIndex: startPage });
                }
              });
            }
          });
        }
      }
    }
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
