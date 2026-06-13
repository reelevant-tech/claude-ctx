pub enum Suit {
    Hearts,
    Spades,
}

impl Suit {
    pub fn rank(&self) -> u8 {
        0
    }
}

pub fn shuffle(seed: u64) -> Vec<u8> {
    vec![(seed % 52) as u8]
}
