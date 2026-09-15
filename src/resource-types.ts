/** Wire records shared by the resource importer and its browser UI. */
export interface ResourceFile { path: string; base64: string }
export interface ResourceImportRequest {
  kind: 'skill' | 'rule'
  level: 'project' | 'user'
  path: string
  files: ResourceFile[]
  sourceDir?: string
  expectedHash?: string
}
export interface ResourcePreview {
  ok: boolean
  name: string
  description: string
  content: string
  target: string
  files: number
  bytes: number
  hash: string
  conflict: boolean
  error?: string
}
