export interface Warning {
  code: string;
  message: string;
  plugin?: string;
}

export class WarningCollector {
  readonly #items: Warning[] = [];
  add(w: Warning): void {
    this.#items.push(w);
  }
  list(): readonly Warning[] {
    return this.#items;
  }
  get isEmpty(): boolean {
    return this.#items.length === 0;
  }
}
