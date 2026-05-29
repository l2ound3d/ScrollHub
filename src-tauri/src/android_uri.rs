/// Stable identifier for Android Storage Access Framework URIs.
/// Document IDs stay the same across app restarts even when the full URI string varies.
pub fn content_uri_stable_key(path: &str) -> Option<String> {
    if !path.starts_with("content://") {
        return None;
    }

    const DOCUMENT_MARKER: &str = "/document/";
    let idx = path.find(DOCUMENT_MARKER)?;
    let doc_id = path[idx + DOCUMENT_MARKER.len()..]
        .split('#')
        .next()?
        .split('?')
        .next()?;
    if doc_id.is_empty() {
        return None;
    }

    Some(format!("content-doc:{doc_id}"))
}

pub fn progress_storage_key(path: &str) -> String {
    content_uri_stable_key(path).unwrap_or_else(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_document_id_from_content_uri() {
        let uri = "content://com.android.externalstorage.documents/document/primary%3ADownload%2Fcomic.cbz";
        assert_eq!(
            content_uri_stable_key(uri),
            Some("content-doc:primary%3ADownload%2Fcomic.cbz".into())
        );
    }
}
