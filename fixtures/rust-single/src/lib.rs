mod parser;

pub struct Engine;

pub trait Scorer {
    fn score(&self) -> u32;
}

pub fn evaluate(input: &str) -> u32 {
    parser::parse_input(input).len() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_evaluate() {
        assert_eq!(evaluate("a b"), 2);
    }
}
