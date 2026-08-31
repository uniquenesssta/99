import type React from 'react'

export interface TagSuggestionKeyDownOptions {
  suggestions: string[]
  activeIndex: number
  inputValue: string
  setActiveIndex: (updater: (index: number) => number) => void
  addTagByName: (name: string) => void
  clearInput: () => void
}

export function isKeyboardCompositionEvent(event: React.KeyboardEvent<HTMLInputElement>): boolean {
  const nativeEvent = event.nativeEvent as KeyboardEvent & { isComposing?: boolean }
  return Boolean(nativeEvent.isComposing) || nativeEvent.keyCode === 229
}

export function handleTagCreateInputKeyDown(
  event: React.KeyboardEvent<HTMLInputElement>,
  createTag: () => void
): void {
  if (isKeyboardCompositionEvent(event)) return
  if (event.key === 'Enter') {
    event.preventDefault()
    createTag()
  }
}

export function handleTagSuggestionInputKeyDown(
  event: React.KeyboardEvent<HTMLInputElement>,
  options: TagSuggestionKeyDownOptions
): void {
  if (isKeyboardCompositionEvent(event)) return

  if (event.key === 'ArrowDown' && options.suggestions.length) {
    event.preventDefault()
    options.setActiveIndex((index) => Math.min(index + 1, options.suggestions.length - 1))
    return
  }

  if (event.key === 'ArrowUp' && options.suggestions.length) {
    event.preventDefault()
    options.setActiveIndex((index) => Math.max(index - 1, 0))
    return
  }

  if (event.key === 'Enter') {
    event.preventDefault()
    options.addTagByName(options.suggestions[options.activeIndex] || options.inputValue)
    return
  }

  if (event.key === 'Escape') {
    options.clearInput()
  }
}
