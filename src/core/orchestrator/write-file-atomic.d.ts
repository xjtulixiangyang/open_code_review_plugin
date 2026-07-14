declare module "write-file-atomic" {
  const writeFileAtomic: {
    (
      filename: string,
      data: string | Buffer,
      options?:
        | string
        | {
            encoding?: string;
            mode?: number;
            chown?: { uid: number; gid: number };
            fsync?: boolean;
          },
    ): Promise<void>;
    sync(
      filename: string,
      data: string | Buffer,
      options?:
        | string
        | {
            encoding?: string;
            mode?: number;
            chown?: { uid: number; gid: number };
            fsync?: boolean;
          },
    ): void;
  };
  export default writeFileAtomic;
}
