import type { FontItem,SystemInstalledFont } from '../../shared/types'

export const DEFAULT_WINDOWS_CLEAN_FONT_FILES = new Set([
  'arial.ttf', 'arialbd.ttf', 'arialbi.ttf', 'ariali.ttf', 'ariblk.ttf',
  'bahnschrift.ttf',
  'calibri.ttf', 'calibrib.ttf', 'calibrii.ttf', 'calibril.ttf', 'calibrili.ttf', 'calibriz.ttf',
  'cambria.ttc', 'cambriab.ttf', 'cambriai.ttf', 'cambriaz.ttf',
  'candara.ttf', 'candarab.ttf', 'candarai.ttf', 'candaral.ttf', 'candarali.ttf', 'candaraz.ttf',
  'comic.ttf', 'comicbd.ttf', 'comici.ttf', 'comicz.ttf',
  'consola.ttf', 'consolab.ttf', 'consolai.ttf', 'consolaz.ttf',
  'constan.ttf', 'constanb.ttf', 'constani.ttf', 'constanz.ttf',
  'corbel.ttf', 'corbelb.ttf', 'corbeli.ttf', 'corbell.ttf', 'corbelli.ttf', 'corbelz.ttf',
  'cour.ttf', 'courbd.ttf', 'courbi.ttf', 'couri.ttf',
  'ebrima.ttf', 'ebrimabd.ttf',
  'framd.ttf', 'framdit.ttf',
  'gabriola.ttf',
  'gadugi.ttf', 'gadugib.ttf',
  'georgia.ttf', 'georgiab.ttf', 'georgiai.ttf', 'georgiaz.ttf',
  'holomdl2.ttf',
  'impact.ttf',
  'inkfree.ttf',
  'javatext.ttf',
  'leelawad.ttf', 'leelawdb.ttf', 'leeluisl.ttf',
  'lucon.ttf',
  'l_10646.ttf',
  'malgun.ttf', 'malgunbd.ttf', 'malgunsl.ttf',
  'marlett.ttf',
  'micross.ttf',
  'mmrtext.ttf', 'mmrtextb.ttf',
  'monbaiti.ttf',
  'msgothic.ttc',
  'msjh.ttc', 'msjhbd.ttc', 'msjhl.ttc',
  'msyh.ttc', 'msyhbd.ttc', 'msyhl.ttc',
  'mvboli.ttf',
  'ntailu.ttf', 'ntailub.ttf',
  'phagspa.ttf', 'phagspab.ttf',
  'segmdl2.ttf',
  'segoepr.ttf', 'segoeprb.ttf',
  'segoesc.ttf', 'segoescb.ttf',
  'segoeui.ttf', 'segoeuib.ttf', 'segoeuii.ttf', 'segoeuil.ttf', 'segoeuisl.ttf', 'segoeuiz.ttf',
  'seguibl.ttf', 'seguibli.ttf', 'seguiemj.ttf', 'seguihis.ttf', 'seguili.ttf', 'seguisb.ttf',
  'seguisbi.ttf', 'seguisli.ttf', 'seguisym.ttf',
  'simsun.ttc', 'simsunb.ttf', 'simsunextg.ttf',
  'deng.ttf', 'dengb.ttf', 'dengl.ttf',
  'simfang.ttf', 'simkai.ttf', 'simhei.ttf', 'simli.ttf', 'simyou.ttf',
  'himalaya.ttf', 'msyi.ttf', 'nirmala.ttf', 'nirmalab.ttf', 'nirmalas.ttf',
  'notosanssc-vf.ttf',
  'sylfaen.ttf',
  'symbol.ttf',
  'tahoma.ttf', 'tahomabd.ttf',
  'taile.ttf', 'taileb.ttf',
  'times.ttf', 'timesbd.ttf', 'timesbi.ttf', 'timesi.ttf',
  'trebuc.ttf', 'trebucbd.ttf', 'trebucbi.ttf', 'trebucit.ttf',
  'verdana.ttf', 'verdanab.ttf', 'verdanai.ttf', 'verdanaz.ttf',
  'webdings.ttf',
  'wingding.ttf',
  'yugothb.ttc', 'yugothl.ttc', 'yugothm.ttc', 'yugothr.ttc',
  'mingliu.ttc', 'mingliub.ttc',
  'msmincho.ttc',
  'batang.ttc', 'gulim.ttc',
  'segoeuihis.ttf',
  'seguiflu.ttf'
])




export function systemMatchSqlExpression(): string {
  return `(COALESCE(install_status.by_type, '') IN ('system', 'both') OR fonts.system_imported = 1 OR LOWER(REPLACE(fonts.path, '/', char(92))) LIKE '%\\windows\\fonts\\%')`
}

export function legacyCleanSystemSqlExpression(): string {
  const cleanNames = Array.from(DEFAULT_WINDOWS_CLEAN_FONT_FILES)
  if (!cleanNames.length) return '0'
  const cleanNameIn = cleanNames.map((name) => `'${name.replace(/'/g, "''")}'`).join(', ')
  return `((fonts.system_imported = 1 OR LOWER(REPLACE(fonts.path, '/', char(92))) LIKE '%\\windows\\fonts\\%') AND LOWER(fonts.file_name) IN (${cleanNameIn}))`
}

export function cleanSystemSqlExpression(): string {
  return `(COALESCE(install_status.system_default, 0) = 1 OR ${systemMatchSqlExpression()})`
}


export function cleanFontFileName(value?: string): string {
  if (!value) return ''
  return value.replaceAll('/', '\\').split('\\').pop()?.trim().toLowerCase() || ''
}

export function isCleanWindowsDefaultFontName(value?: string): boolean {
  const name = cleanFontFileName(value)
  return !!name && DEFAULT_WINDOWS_CLEAN_FONT_FILES.has(name)
}

export function isCleanWindowsDefaultCandidate(candidate: SystemInstalledFont): boolean {
  return (
    isCleanWindowsDefaultFontName(candidate.fileName) ||
    isCleanWindowsDefaultFontName(candidate.path) ||
    isCleanWindowsDefaultFontName(candidate.value) ||
    isCleanWindowsDefaultFontName(candidate.registryName)
  )
}

export function isCleanWindowsDefaultItem(item: FontItem): boolean {
  if (isCleanWindowsDefaultFontName(item.fileName) || isCleanWindowsDefaultFontName(item.path)) return true
  return !!item.systemInstallMatches?.some(isCleanWindowsDefaultCandidate)
}


