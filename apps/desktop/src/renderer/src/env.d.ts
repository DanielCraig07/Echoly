/// <reference types="vite/client" />
import type { IpcApi } from '@deepseek-ide/shared';

declare global {
  interface Window {
    ide: IpcApi;
  }
}

declare module '*?worker' {
  const workerConstructor: {
    new (): Worker;
  };
  export default workerConstructor;
}

declare module '*.png' {
  const src: string;
  export default src;
}

declare module 'monaco-editor/esm/*' {
  const content: any;
  export default content;
  export const ActionViewItem: any;
  export const Menu: any;
}

export {};
