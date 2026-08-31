export type PreviewLayoutMode = 'grid' | 'list' | 'detail'

export type PreviewLayoutSpec = {
  width: number
  height: number
  paddingX: number
  paddingY: number
  maxFontSize: number
  minFontSize: number
  lineHeight: number
  maxLines: number
  capacityUnits: number
}

export type PreviewTextFit = {
  fontSize: number
  lineHeight: number
  maxLines: number
  textAlign: 'center'
}
