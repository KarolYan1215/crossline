"use client";

import { useRef, useState, type ClipboardEvent, type DragEvent } from "react";

/**
 * The drag/paste/hidden-input attachment pattern `OfflineCaptureForm` introduced, pulled out so the
 * floating assistant widget (`assistant-widget.tsx`) can reuse it rather than re-implementing the same
 * `DataTransfer`-merging logic. The native `<input type="file">` stays the single source of truth for
 * what is actually selected; drag and paste just add to its `FileList` through a `DataTransfer`.
 */
export function useAttachmentDrop(acceptedTypes: string[]) {
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = (incoming: FileList | File[]) => {
    const input = fileInputRef.current;
    if (!input) return;
    const existing = [...(input.files ?? [])];
    const merged = new DataTransfer();
    const seen = new Set(existing.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
    for (const file of [...existing, ...incoming]) {
      // A type, or an extension (".md"): Windows often gives Markdown and some Word files no type at all.
      if (!acceptedTypes.includes(file.type) && !acceptedTypes.some((type) => type.startsWith(".") && file.name.toLowerCase().endsWith(type))) continue;
      const key = `${file.name}:${file.size}:${file.lastModified}`;
      if (seen.has(key) && !existing.includes(file)) continue;
      seen.add(key);
      merged.items.add(file);
    }
    input.files = merged.files;
    setFileNames([...merged.files].map((file) => file.name));
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragOver(false);
    if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
  };
  const onPaste = (event: ClipboardEvent<HTMLElement>) => {
    const pasted = [...event.clipboardData.files,
      ...[...event.clipboardData.items].flatMap((item) => { const file = item.kind === "file" ? item.getAsFile() : null; return file ? [file] : []; })];
    if (pasted.length) addFiles(pasted);
  };
  const reset = () => {
    const input = fileInputRef.current;
    if (input) input.value = "";
    setFileNames([]);
  };
  // Picking via the native file dialog bypasses `addFiles` (the browser already wrote `input.files`
  // itself) — this just keeps the displayed name list in sync with whatever the input now holds.
  const onInputChange = () => setFileNames([...(fileInputRef.current?.files ?? [])].map((file) => file.name));
  return { fileInputRef, fileNames, dragOver, setDragOver, addFiles, onDrop, onPaste, onInputChange, reset };
}
