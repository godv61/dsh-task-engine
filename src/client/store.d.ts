/**
 * Ambient types for the `@deepseek-ai/dsh-client-store` baseline external.
 *
 * The DSH shell provides the store engine at runtime (the client bundle does
 * not copy it), so this declaration is type-check-only and mirrors the narrow
 * slice this plugin uses: `defineStore` plus the handle/instance it returns.
 * It never reaches `lib/client.js` because esbuild does not bundle `.d.ts`.
 *
 * `Baked` inlines only the transformation that matters here — the action's
 * leading draft parameter is removed, so `open: (d) => void` becomes the
 * `open(): void` a component calls.
 *
 * @module dsh-task-engine/store (ambient)
 */

declare module '@deepseek-ai/dsh-client-store' {
  /** An action table with each draft parameter removed by the engine. */
  export type Baked<A> = {
    [K in keyof A]: A[K] extends (draft: unknown, ...args: infer P) => void ? (...args: P) => void : A[K]
  }

  /** A live engine instance: snapshot access plus the baked action table. */
  export interface StoreInstance<T, A> {
    getSnapshot(): T
    subscribe(listener: () => void): () => void
    actions: A
  }

  /** The engine-backed handle; shared identity keys instance sharing. */
  export interface EngineStoreHandle<T, A> {
    create(scopeKey?: string): StoreInstance<T, A>
  }

  export function defineStore<T, A extends Record<string, (draft: T, ...args: unknown[]) => void>>(
    decl: { init(): T; persist?: string; actions: A },
  ): EngineStoreHandle<T, Baked<A>>
}