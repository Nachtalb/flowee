/** Where files the owner sends are put; returns their public URL. */
export interface Files {
  upload(name: string, bytes: ArrayBuffer): Promise<string>;
}
