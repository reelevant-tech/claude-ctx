mod cards;

pub struct Deck;

pub trait Evaluator {
    fn eval(&self) -> i64;
}

pub fn evaluate_hand(cards: &[u8]) -> i64 {
    cards.iter().map(|c| *c as i64).sum()
}

macro_rules! card_macro {
    () => {};
}

card_macro!();
