export interface TextSearchRequest {
  projectPath: string
  query: string
  fixedStrings?: boolean
  ignoreCase?: boolean
  globs?: readonly string[]
  maxResults?: number
}

export interface TextSearchResult {
  root: string
  query: string
  status: 'ok' | 'truncated' | 'cancelled' | 'timed-out' | 'failed'
  matches: Array<{ path: string; line: number; column: number; text: string }>
  truncated: boolean
  exitCode: number | null
  error?: string
}
