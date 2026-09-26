"""Original geometric font fixtures, dedicated to the public domain (CC0).
Regenerate with fontTools 4.61.1; never derived from installed/vendor fonts.
Only the generator needs fontTools; the Windows test uses Python stdlib.
"""
import base64, io, json
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.ttLib import TTCollection, newTable
from fontTools.ttLib.tables._f_v_a_r import Axis
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString

def make(wide=False, cff=False):
    fb = FontBuilder(1000, isTTF=not cff)
    order = ['.notdef', 'space', 'A', 'B', 'acute', 'fi']
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({32:'space',65:'A',66:'B',102:'A',105:'B',0x301:'acute',0x4e2d:'A',0x6587:'B',0x5d0:'A',0x5d1:'B',0x1f600:'A'})
    contours = {'.notdef':[(50,0),(250,0),(250,500),(50,500)], 'space':[],
      'A':[(50,-100),(850 if wide else 350,-100),(850 if wide else 350,850),(50,850)],
      'B':[(50,0),(500,0),(275,650)],'acute':[(0,700),(100,700),(200,900),(100,900)],
      'fi':[(50,0),(900,0),(900,300),(50,300)]}
    glyphs = {}
    for name, points in contours.items():
        pen = T2CharStringPen(1000,None) if cff else TTGlyphPen(None)
        if points:
            pen.moveTo(points[0])
            for point in points[1:]: pen.lineTo(point)
            pen.closePath()
        glyphs[name] = pen.getCharString() if cff else pen.glyph()
    if cff: fb.setupCFF('HFMFixtureCFF', {'FullName':'HFMFixtureCFF','FamilyName':'HFM Fixture','Weight':'Regular'},glyphs,{})
    else: fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({n:(1000 if wide else 600,0) for n in order})
    fb.setupHorizontalHeader(ascent=900,descent=-200)
    fb.setupNameTable({'familyName':'HFM DW Fixture','styleName':'Regular','uniqueFontIdentifier':f'HFM-original-{wide}-{cff}', 'fullName':'HFM DW Fixture Regular','psName':f'HFMFixture{int(wide)}{int(cff)}'})
    fb.setupOS2(sTypoAscender=900,sTypoDescender=-200,usWinAscent=900,usWinDescent=200)
    fb.setupPost()
    addOpenTypeFeaturesFromString(fb.font,'feature liga { sub A B by fi; } liga;')
    # Pin timestamps for reproducibility.
    fb.font['head'].created = fb.font['head'].modified = 3800000000
    return fb.font
fonts = {'narrow.ttf':make(), 'wide.ttf':make(True), 'outline.otf':make(cff=True)}
variable=make()
fvar=newTable('fvar'); axis=Axis(); axis.axisTag='wght'; axis.minValue=100; axis.defaultValue=400; axis.maxValue=900; axis.flags=0; axis.axisNameID=256
fvar.axes=[axis]; fvar.instances=[]; variable['fvar']=fvar
variable['name'].setName('Weight',256,3,1,0x409)
gvar=newTable('gvar'); gvar.version=1; gvar.reserved=0; gvar.variations={name:[] for name in variable.getGlyphOrder()}; variable['gvar']=gvar
fonts['variable.ttf']=variable
collection=TTCollection();collection.fonts=[make(),make(True)];fonts['faces.ttc']=collection
result={}
for name,font in fonts.items():
    out=io.BytesIO();font.save(out);result[name]=base64.b64encode(out.getvalue()).decode('ascii')
Path(__file__).with_name('fonts.json').write_text(json.dumps(result,indent=2)+'\n')
