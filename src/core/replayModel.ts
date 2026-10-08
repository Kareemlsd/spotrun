import { FrameRecord, Resolution, RunResult, Step } from "./types";

export interface LineAnnotation {
  /** 1-based line */
  line: number;
  writes: Record<string, string>;
  ret?: string;
  exc?: string;
  /** how many times this line ran before the current position */
  hits: number;
}

export interface FrameView {
  frame: FrameRecord;
  /** 1-based line the frame is currently at, undefined when it has finished */
  line: number | undefined;
  locals: Record<string, string>;
  annotations: Map<number, LineAnnotation>;
}

/**
 * Position in a recorded run. `index` ranges from 0 (about to execute the
 * first recorded line) to steps.length (run finished).
 */
export class ReplayModel {
  readonly steps: Step[];
  readonly frames: FrameRecord[];
  index = 0;

  /**
   * For each step, the index from which its effects are visible: the next
   * step that is not inside a call made from that line. A line such as
   * `x = helper(a)` only assigns `x` once `helper` has returned.
   */
  private readonly visibleFrom: number[];

  constructor(readonly result: RunResult) {
    this.steps = result.steps ?? [];
    this.frames = result.frames ?? [];
    this.visibleFrom = new Array(this.steps.length).fill(this.steps.length);
    const pending: number[] = [];
    for (let j = 0; j < this.steps.length; j++) {
      const depth = this.depthOf(this.steps[j]);
      while (pending.length > 0 && this.depthOf(this.steps[pending[pending.length - 1]]) >= depth) {
        this.visibleFrom[pending.pop()!] = j;
      }
      pending.push(j);
    }
  }

  get length(): number {
    return this.steps.length;
  }

  get atEnd(): boolean {
    return this.index >= this.steps.length;
  }

  get current(): Step | undefined {
    return this.steps[this.index];
  }

  private depthOf(step: Step): number {
    return this.frames[step.f]?.depth ?? 0;
  }

  goTo(index: number): boolean {
    const clamped = Math.max(0, Math.min(this.steps.length, index));
    const moved = clamped !== this.index;
    this.index = clamped;
    return moved;
  }

  stepInto(): boolean {
    return this.goTo(this.index + 1);
  }

  /** Next step that is not inside a call made from the current line. */
  stepOver(): boolean {
    const here = this.current;
    if (!here) {
      return false;
    }
    const depth = this.depthOf(here);
    for (let i = this.index + 1; i < this.steps.length; i++) {
      if (this.depthOf(this.steps[i]) <= depth) {
        return this.goTo(i);
      }
    }
    return this.goTo(this.steps.length);
  }

  /** Next step in a caller of the current frame. */
  stepOut(): boolean {
    const here = this.current;
    if (!here) {
      return false;
    }
    const depth = this.depthOf(here);
    for (let i = this.index + 1; i < this.steps.length; i++) {
      if (this.depthOf(this.steps[i]) < depth) {
        return this.goTo(i);
      }
    }
    return this.goTo(this.steps.length);
  }

  /** Previous step at the same depth or shallower (reverse step over). */
  stepBack(): boolean {
    if (this.index === 0) {
      return false;
    }
    if (this.atEnd) {
      // From the end, land on the last step of the outermost frame.
      for (let i = this.steps.length - 1; i >= 0; i--) {
        if (this.depthOf(this.steps[i]) === 0) {
          return this.goTo(i);
        }
      }
      return this.goTo(this.steps.length - 1);
    }
    const depth = this.depthOf(this.current!);
    for (let i = this.index - 1; i >= 0; i--) {
      if (this.depthOf(this.steps[i]) <= depth) {
        return this.goTo(i);
      }
    }
    return this.goTo(0);
  }

  /** Index of the step where the reported exception was raised, if any. */
  failingIndex(): number | undefined {
    if (!this.result.exception) {
      return undefined;
    }
    for (let i = this.steps.length - 1; i >= 0; i--) {
      if (this.steps[i].exc) {
        // Innermost frame that raised: walk back while deeper steps also raised.
        let best = i;
        for (let j = i - 1; j >= 0 && this.steps[j].exc && this.depthOf(this.steps[j]) > this.depthOf(this.steps[best]); j--) {
          best = j;
        }
        return best;
      }
    }
    return undefined;
  }

  /** Frames on the call stack at the current position, outermost first. */
  stack(): FrameView[] {
    const active: number[] = [];
    if (this.atEnd) {
      if (this.frames.length > 0) {
        active.push(0);
      }
    } else {
      let id = this.current!.f;
      while (id >= 0 && this.frames[id]) {
        active.unshift(id);
        id = this.frames[id].parent;
      }
    }
    const views = new Map<number, FrameView>();
    for (const id of active) {
      const frame = this.frames[id];
      views.set(id, { frame, line: undefined, locals: { ...frame.args }, annotations: new Map() });
    }
    const limit = Math.min(this.index, this.steps.length);
    for (let i = 0; i < limit; i++) {
      const step = this.steps[i];
      const view = views.get(step.f);
      if (!view) {
        continue;
      }
      let annotation = view.annotations.get(step.l);
      if (!annotation) {
        annotation = { line: step.l, writes: {}, hits: 0 };
        view.annotations.set(step.l, annotation);
      }
      annotation.hits += 1;
      if (this.visibleFrom[i] > this.index) {
        // Still inside a call made from this line: nothing assigned yet.
        continue;
      }
      // The latest execution that assigned something is what the line shows.
      // A loop header's final pass, which assigns nothing, keeps the last item.
      if (step.w) {
        annotation.writes = { ...step.w };
      }
      annotation.ret = step.ret ?? annotation.ret;
      annotation.exc = step.exc;
      if (step.w) {
        Object.assign(view.locals, step.w);
      }
    }
    if (!this.atEnd) {
      // Each active frame is paused on the line of its latest step at or
      // before the current index.
      for (const id of active) {
        const view = views.get(id)!;
        for (let i = this.index; i >= 0; i--) {
          if (this.steps[i].f === id) {
            view.line = this.steps[i].l;
            break;
          }
        }
      }
    }
    return active.map((id) => views.get(id)!);
  }

  /** Fake values that have been invented up to the current position. */
  invented(): Resolution[] {
    return (this.result.resolutions ?? []).filter((r) => !r.error && r.value !== null && (this.atEnd || r.step <= this.index));
  }

  /** Text printed up to the current position. */
  output(): { kind: "out" | "err"; text: string }[] {
    const chunks: { kind: "out" | "err"; text: string }[] = [];
    for (const [step, kind, text] of this.result.outputs ?? []) {
      if (step <= this.index || this.atEnd) {
        chunks.push({ kind, text });
      }
    }
    return chunks;
  }

  /** One-line summary of how the run ended. */
  outcome(): string {
    const result = this.result;
    if (result.exception) {
      return `${result.exception.type}: ${result.exception.message}`;
    }
    return `→ ${result.return ?? "None"}`;
  }
}

/** Compact "a = 1, b = 2" text for an inline annotation. */
export function formatWrites(writes: Record<string, string>, maxLength = 120): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(writes)) {
    parts.push(`${name} = ${value}`);
  }
  return truncate(parts.join(", "), maxLength);
}

/** Keeps the end of a long fake path, which is the part that identifies the value. */
export function shortPath(path: string, maxLength = 48): string {
  return path.length > maxLength ? "…" + path.slice(path.length - maxLength + 1) : path;
}

export function truncate(text: string, maxLength: number): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > maxLength ? flat.slice(0, maxLength - 1) + "…" : flat;
}
