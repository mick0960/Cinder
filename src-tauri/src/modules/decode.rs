pub fn decode(bytes: &[u8]) -> String {
    let (cow, _, had_errors) = encoding_rs::UTF_8.decode(bytes);
    if had_errors {
        let (gbk, _, _) = encoding_rs::GBK.decode(bytes);
        gbk.into_owned()
    } else {
        cow.into_owned()
    }
}
