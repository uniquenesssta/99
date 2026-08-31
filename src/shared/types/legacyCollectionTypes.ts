export type LibraryItemScope = 'shared' | 'local'

export interface FontCollection {
  id: string
  name: string
  createdAt: string
  scope?: LibraryItemScope
}
