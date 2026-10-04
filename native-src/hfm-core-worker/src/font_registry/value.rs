// Decode bounded registry data identically during enumeration and pre-delete
// verification. Win32 does not guarantee a stored REG_SZ terminator.
use std::io;

pub(crate) fn decode(name:&str,kind:u32,data:&[u16],bytes:u32)->io::Result<Option<String>> {
    let invalid=|reason:&str|io::Error::other(reason);
    if bytes%2!=0 || bytes as usize/2>data.len() {
        return Err(invalid("invalid registry value byte length"));
    }
    // Numeric metadata is not a font path. Classify by type and exact width,
    // never by a special value name; preserve the registry entry untouched.
    let numeric_bytes=match kind {4|5=>Some(4),11=>Some(8),_=>None};
    if let Some(expected)=numeric_bytes {
        return if bytes==expected {Ok(None)}else{Err(invalid("invalid numeric registry value byte length"))};
    }
    if name.is_empty() && kind==0 && bytes==0 {return Ok(None)}
    if kind!=1 {return Err(invalid("unsupported font registry type (expected REG_SZ)"))}
    let units=&data[..bytes as usize/2];
    let end=units.iter().position(|unit|*unit==0).unwrap_or(units.len());
    // Accept missing terminators and trailing NUL padding, not a hidden second
    // value that would be interpreted differently by another consumer.
    if units[end..].iter().any(|unit|*unit!=0) {
        return Err(invalid("embedded NUL followed by nonzero registry data"));
    }
    let value=String::from_utf16(&units[..end]).map_err(|_|invalid("invalid UTF-16 registry path"))?;
    if value.is_empty(){Ok(None)}else{Ok(Some(value))}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminated_and_unterminated_paths_have_identical_identity() {
        let text="C:\\Fonts\\测试.ttf";
        let mut units:Vec<u16>=text.encode_utf16().collect();
        let bytes=units.len() as u32*2;
        assert_eq!(decode("Font",1,&units,bytes).unwrap(),Some(text.into()));
        units.extend([0,0]);
        assert_eq!(decode("Font",1,&units,bytes+4).unwrap(),Some(text.into()));
        // Unused buffer contents are not part of the returned registry value.
        units.push(0xFFFF);
        assert_eq!(decode("Font",1,&units,bytes).unwrap(),Some(text.into()));
    }
    #[test]
    fn empty_strings_and_empty_default_have_no_file_reference() {
        assert_eq!(decode("",0,&[],0).unwrap(),None);
        assert_eq!(decode("Font",1,&[],0).unwrap(),None);
        assert_eq!(decode("",1,&[0,0],4).unwrap(),None);
    }
    #[test]
    fn unsupported_types_do_not_become_missing_references() {
        for kind in [0,2,3,6,7,99] {assert!(decode("Font",kind,&[],0).is_err());}
        assert!(decode("",0,&[1],2).is_err());
    }
    #[test]
    fn numeric_metadata_is_not_a_font_reference() {
        // Reproduce the observed DWORD without depending on its name/value.
        assert_eq!(decode("sdk_init_timestamp",4,&[0xD800,0xFFFF],4).unwrap(),None);
        for (kind,bytes) in [(4,4),(5,4),(11,8)] {
            assert_eq!(decode("Other metadata",kind,&[0xFFFF;4],bytes).unwrap(),None);
            for invalid_bytes in [0,2,6,10] {
                assert!(decode("Metadata",kind,&[0;5],invalid_bytes).is_err());
            }
            assert!(decode("Metadata",kind,&[0],bytes).is_err());
        }
        // A string with the observed metadata name remains a real reference.
        assert_eq!(decode("sdk_init_timestamp",1,&[65,0],4).unwrap(),Some("A".into()));
    }
    #[test]
    fn malformed_strings_are_refused() {
        assert!(decode("Font",1,&[65],1).is_err());
        assert!(decode("Font",1,&[65],4).is_err());
        assert!(decode("Font",1,&[65,0,66],6).is_err());
        assert!(decode("Font",1,&[0xD800],2).is_err());
    }
}
