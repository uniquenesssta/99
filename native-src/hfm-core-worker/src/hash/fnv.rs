pub const FNV_OFFSET_BASIS: u64 = 0xcbf29ce484222325;
pub const FNV_PRIME: u64 = 0x00000100000001b3;

#[derive(Clone, Debug)]
pub struct Fnv1a64 {
    state: u64,
}

impl Fnv1a64 {
    pub fn new() -> Self {
        Self { state: FNV_OFFSET_BASIS }
    }

    pub fn update(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.state ^= u64::from(*byte);
            self.state = self.state.wrapping_mul(FNV_PRIME);
        }
    }

    pub fn finish_hex(&self) -> String {
        format!("{:016x}", self.state)
    }
}
