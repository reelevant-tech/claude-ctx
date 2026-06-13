use crate::Engine;

pub(crate) const MAX_DEPTH: usize = 8;

pub fn parse_input(s: &str) -> Vec<String> {
    let _engine = Engine;
    s.split_whitespace().take(MAX_DEPTH).map(String::from).collect()
}
