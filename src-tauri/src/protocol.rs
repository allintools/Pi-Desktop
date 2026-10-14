use serde_json::Value;
use std::io::{BufRead, Read};
pub enum Error {
    Io,
    Invalid,
    TooLong,
}
pub fn record<R: BufRead>(
    reader: &mut R,
    bytes: &mut Vec<u8>,
    limit: u64,
) -> Result<Option<Value>, Error> {
    bytes.clear();
    let n = Read::by_ref(reader)
        .take(limit + 1)
        .read_until(b'\n', bytes)
        .map_err(|_| Error::Io)?;
    if n == 0 {
        return Ok(None);
    }
    if n as u64 > limit {
        return Err(Error::TooLong);
    }
    if bytes.last() != Some(&b'\n') {
        return Err(Error::Invalid);
    }
    serde_json::from_slice(bytes)
        .map(Some)
        .map_err(|_| Error::Invalid)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};
    struct Split(Cursor<Vec<u8>>);
    impl Read for Split {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            let length = out.len().min(2);
            self.0.read(&mut out[..length])
        }
    }
    #[test]
    fn split_utf8_crlf_and_unicode_separator() {
        let input = "{\"text\":\"中文\u{2028}✓\"}\r\n{\"id\":2}\n";
        let mut r = BufReader::new(Split(Cursor::new(input.as_bytes().to_vec())));
        let mut bytes = Vec::new();
        assert_eq!(
            record(&mut r, &mut bytes, 1000).ok().flatten().unwrap()["text"],
            "中文\u{2028}✓"
        );
        assert_eq!(
            record(&mut r, &mut bytes, 1000).ok().flatten().unwrap()["id"],
            2
        );
        assert!(record(&mut r, &mut bytes, 1000).ok().flatten().is_none());
    }
    #[test]
    fn malformed_record_recovers_and_dangling_record_is_rejected() {
        let mut r = Cursor::new(b"not-json\n{\"ok\":true}\n{}");
        let mut bytes = Vec::new();
        assert!(matches!(
            record(&mut r, &mut bytes, 100),
            Err(Error::Invalid)
        ));
        assert_eq!(
            record(&mut r, &mut bytes, 100).ok().flatten().unwrap()["ok"],
            true
        );
        assert!(matches!(
            record(&mut r, &mut bytes, 100),
            Err(Error::Invalid)
        ));
    }
    #[test]
    fn oversized_record_does_not_allocate_full_output() {
        let mut r = Cursor::new(vec![b'x'; 1_000_000]);
        let mut bytes = Vec::new();
        assert!(matches!(
            record(&mut r, &mut bytes, 256),
            Err(Error::TooLong)
        ));
        assert_eq!(bytes.len(), 257);
        assert_eq!(r.position(), 257);
    }
}
