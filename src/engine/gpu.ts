// Device helpers: shader compilation with errors surfaced, explicit bind-group layouts from a manifest.

import type { ShaderManifest } from "../manifest.js";

/** A WGSL compile or pipeline error, with the offending source lines (hook text included). */
export class ZilionShaderError extends Error {
  readonly messages: readonly { type: string; line: number; column: number; message: string }[];
  constructor(message: string, messages: ZilionShaderError["messages"] = []) {
    super(message);
    this.name = "ZilionShaderError";
    this.messages = messages;
  }
}

function describe(code: string, msgs: readonly GPUCompilationMessage[]): string {
  const lines = code.split("\n");
  return msgs
    .map((m) => {
      const src = m.lineNum > 0 ? lines[m.lineNum - 1] ?? "" : "";
      const caret = m.linePos > 0 ? `${" ".repeat(m.linePos - 1)}^` : "";
      return `${m.type} at line ${m.lineNum}:${m.linePos}: ${m.message}${src ? `\n    ${src}\n    ${caret}` : ""}`;
    })
    .join("\n");
}

/** createShaderModule, then fail with every compiler error (and the source line) instead of a silent console log. */
export async function compileShader(device: GPUDevice, code: string, label: string): Promise<GPUShaderModule> {
  device.pushErrorScope("validation");
  const module = device.createShaderModule({ label, code });
  const info = typeof module.getCompilationInfo === "function" ? await module.getCompilationInfo() : null;
  const scoped = await device.popErrorScope();
  const errors = info ? info.messages.filter((m) => m.type === "error") : [];
  if (errors.length > 0 || scoped) {
    const text = errors.length > 0 ? describe(code, errors) : scoped!.message;
    throw new ZilionShaderError(
      `zilion: WGSL compilation failed (${label}):\n${text}`,
      errors.map((m) => ({ type: m.type, line: m.lineNum, column: m.linePos, message: m.message })),
    );
  }
  return module;
}

export function bindGroupLayoutFor(device: GPUDevice, manifest: ShaderManifest, label: string): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label,
    entries: manifest.bindings.map((b) => ({
      binding: b.binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: b.type },
    })),
  });
}

/** Compile and create the compute pipeline for a kernel-mode manifest; errors are thrown, not logged. */
export async function createKernel(
  device: GPUDevice,
  wgsl: string,
  manifest: ShaderManifest,
  label: string,
): Promise<{ pipeline: GPUComputePipeline; layout: GPUBindGroupLayout }> {
  if (!manifest.entryPoint) throw new Error("zilion: a library-mode machine has no entry point; embed its WGSL in a host shader");
  const module = await compileShader(device, wgsl, label);
  const layout = bindGroupLayoutFor(device, manifest, label);
  device.pushErrorScope("validation");
  let pipeline: GPUComputePipeline;
  try {
    pipeline = await device.createComputePipelineAsync({
      label,
      layout: device.createPipelineLayout({ label, bindGroupLayouts: [layout] }),
      compute: { module, entryPoint: manifest.entryPoint },
    });
  } catch (e) {
    await device.popErrorScope();
    throw new ZilionShaderError(`zilion: pipeline creation failed (${label}): ${(e as Error).message}`);
  }
  const err = await device.popErrorScope();
  if (err) throw new ZilionShaderError(`zilion: pipeline creation failed (${label}): ${err.message}`);
  return { pipeline, layout };
}
