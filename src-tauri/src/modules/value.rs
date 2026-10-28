//! 模块输出里的数值处理：从文本取数、按阈值规则着色。

use crate::config::Threshold;

/// 整段文本就是一个数：`73`、`73%`、`3/4`（分数换算成百分数）。结果不做截断，保持自然单位。
pub fn whole_number(text: &str) -> Option<f64> {
    let s = text.trim();
    let s = s.strip_suffix('%').map_or(s, str::trim_end);
    if let Some((a, b)) = s.split_once('/') {
        let a: f64 = a.trim().parse().ok()?;
        let b: f64 = b.trim().parse().ok()?;
        return if b > 0.0 { finite(a / b * 100.0) } else { None };
    }
    finite(s.parse::<f64>().ok()?)
}

/// 文本里出现的第一个数：`23ms` → 23，`GPU 61 °C` → 61，`4,361 MB` → 4361。
pub fn first_number(text: &str) -> Option<f64> {
    let b = text.as_bytes();
    let digit_at = |i: usize| b.get(i).is_some_and(u8::is_ascii_digit);
    for i in 0..b.len() {
        // 紧跟在字母数字后面的 - 是连字符（Ubuntu-24.04、2024-05），不是负号
        let signed = matches!(b[i], b'-' | b'+') && digit_at(i + 1) && !(i > 0 && b[i - 1].is_ascii_alphanumeric());
        if !b[i].is_ascii_digit() && !signed {
            continue;
        }
        let mut num = String::new();
        let mut j = i;
        if signed {
            num.push(b[i] as char);
            j += 1;
        }
        while digit_at(j) {
            num.push(b[j] as char);
            j += 1;
            // 千分位：后面恰好跟 3 位数字的逗号（4,361 / 1,234,567）；“59, 4096”这样的列表不算
            if b.get(j) == Some(&b',') && digit_at(j + 1) && digit_at(j + 2) && digit_at(j + 3) && !digit_at(j + 4) {
                j += 1;
            }
        }
        if b.get(j) == Some(&b'.') && digit_at(j + 1) {
            num.push('.');
            j += 1;
            while digit_at(j) {
                num.push(b[j] as char);
                j += 1;
            }
        }
        return finite(num.parse().ok()?);
    }
    None
}

/// 阈值着色、动画驱动使用的“自然数值”：整段是数字时精确取值，否则取文本里的第一个数
pub fn extract_num(text: &str) -> Option<f64> {
    whole_number(text).or_else(|| first_number(text))
}

fn finite(v: f64) -> Option<f64> {
    v.is_finite().then_some(v)
}

/// 返回数值 `n` 命中的阈值规则颜色。
/// 多条规则同时命中时，同方向的取更“极端”的一条（`>70` 与 `>90` 同时命中按 `>90`），与书写顺序无关；
/// 方向不同的规则互不比较，先写的优先。
pub fn threshold_color(rules: &[Threshold], n: f64) -> Option<String> {
    let mut best: Option<&Threshold> = None;
    for r in rules {
        let hit = match r.op.as_str() {
            "gt" => n > r.value,
            "lt" => n < r.value,
            _ => false,
        };
        if !hit || r.color.trim().is_empty() {
            continue;
        }
        best = match best {
            None => Some(r),
            Some(b) if b.op == r.op && ((r.op == "gt" && r.value > b.value) || (r.op == "lt" && r.value < b.value)) => Some(r),
            keep => keep,
        };
    }
    best.map(|r| r.color.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(op: &str, value: f64, color: &str) -> Threshold {
        Threshold { op: op.into(), value, color: color.into() }
    }

    #[test]
    fn whole_numbers() {
        assert_eq!(whole_number("73"), Some(73.0));
        assert_eq!(whole_number(" 73% "), Some(73.0));
        assert_eq!(whole_number("73 %"), Some(73.0));
        assert_eq!(whole_number("3/4"), Some(75.0));
        assert_eq!(whole_number("150"), Some(150.0));
        assert_eq!(whole_number("-5.5"), Some(-5.5));
        assert_eq!(whole_number("1/0"), None);
        assert_eq!(whole_number("23ms"), None);
        assert_eq!(whole_number("inf"), None);
        assert_eq!(whole_number("NaN"), None);
        assert_eq!(whole_number(""), None);
    }

    #[test]
    fn first_numbers() {
        assert_eq!(first_number("23ms"), Some(23.0));
        assert_eq!(first_number("GPU 61 °C"), Some(61.0));
        assert_eq!(first_number("温度：-5.5度"), Some(-5.5));
        assert_eq!(first_number("1.5 GB"), Some(1.5));
        assert_eq!(first_number("v2.3.1"), Some(2.3));
        assert_eq!(first_number("10-20"), Some(10.0));
        assert_eq!(first_number("运行中"), None);
        assert_eq!(first_number("-"), None);
        assert_eq!(first_number("3."), Some(3.0));
    }

    #[test]
    fn hyphens_are_not_minus_signs() {
        assert_eq!(first_number("Ubuntu-24.04, docker-desktop"), Some(24.04));
        assert_eq!(first_number("2024-05-01"), Some(2024.0));
        assert_eq!(first_number("temp:-5.5"), Some(-5.5));
        assert_eq!(first_number("delta -3"), Some(-3.0));
        assert_eq!(first_number("(-3)"), Some(-3.0));
        assert_eq!(first_number("+7 次"), Some(7.0));
    }

    #[test]
    fn thousands_separators() {
        assert_eq!(first_number("vmmemWSL 4,361 MB"), Some(4361.0));
        assert_eq!(first_number("1,234,567 B"), Some(1_234_567.0));
        assert_eq!(first_number("-1,000.5"), Some(-1000.5));
        // 不是千分位的逗号
        assert_eq!(first_number("59, 4096"), Some(59.0));
        assert_eq!(first_number("1,5"), Some(1.0));
        assert_eq!(first_number("12,3456"), Some(12.0));
    }

    #[test]
    fn extract_prefers_whole() {
        assert_eq!(extract_num("3/4"), Some(75.0));
        assert_eq!(extract_num("8.8 / 512 GB"), Some(8.8));
        assert_eq!(extract_num("abc"), None);
    }

    #[test]
    fn thresholds_pick_the_tightest_rule_of_a_direction() {
        let rules = [rule("gt", 70.0, "amber"), rule("gt", 90.0, "red")];
        assert_eq!(threshold_color(&rules, 50.0), None);
        assert_eq!(threshold_color(&rules, 80.0).as_deref(), Some("amber"));
        assert_eq!(threshold_color(&rules, 95.0).as_deref(), Some("red"));
        // 书写顺序不影响结果
        let reversed = [rule("gt", 90.0, "red"), rule("gt", 70.0, "amber")];
        assert_eq!(threshold_color(&reversed, 95.0).as_deref(), Some("red"));
        assert_eq!(threshold_color(&reversed, 80.0).as_deref(), Some("amber"));
    }

    #[test]
    fn thresholds_are_strict_and_support_lt() {
        let rules = [rule("gt", 80.0, "red"), rule("lt", 20.0, "blue"), rule("lt", 10.0, "purple")];
        assert_eq!(threshold_color(&rules, 80.0), None);
        assert_eq!(threshold_color(&rules, 80.1).as_deref(), Some("red"));
        assert_eq!(threshold_color(&rules, 15.0).as_deref(), Some("blue"));
        assert_eq!(threshold_color(&rules, 5.0).as_deref(), Some("purple"));
        assert_eq!(threshold_color(&[rule("eq", 1.0, "x")], 1.0), None);
        assert_eq!(threshold_color(&[rule("gt", 1.0, "  ")], 5.0), None);
    }
}
