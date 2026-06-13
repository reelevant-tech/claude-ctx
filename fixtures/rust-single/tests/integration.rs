use eco_fixture::evaluate;

#[test]
fn integration_works() {
    assert!(evaluate("one two three") > 0);
}
