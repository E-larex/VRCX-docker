use std::{io, sync::LazyLock};

use minijinja::{
    value::{Kwargs, ValueKind},
    AutoEscape, Environment, Error, ErrorKind, UndefinedBehavior,
};
use serde_json::Value;

pub const DEFAULT_WEBHOOK_TEMPLATE: &str = include_str!("webhook-template-default.j2");
const MAX_TEMPLATE_BYTES: usize = 64 * 1024;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;
static TEMPLATE_VARIABLES: LazyLock<Vec<String>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("webhook-template-variables.json"))
        .expect("webhook-template-variables.json must contain a string array")
});

/// Render MiniJinja text, then require a JSON object. Templates must use `tojson`
/// when inserting dynamic JSON values, without surrounding the expression in quotes.
pub fn render_custom_webhook(template: &str, context: &Value) -> Result<Value, String> {
    if template.len() > MAX_TEMPLATE_BYTES {
        return Err("Webhook template exceeds the 64 KiB limit.".into());
    }
    let mut env = Environment::new();
    env.set_auto_escape_callback(|_| AutoEscape::None);
    env.set_undefined_behavior(UndefinedBehavior::Strict);
    env.set_fuel(Some(50_000));
    env.set_recursion_limit(64);
    env.add_filter("tojson", strict_tojson);
    let template = env.template_from_str(template).map_err(template_error)?;
    let mut output = BoundedOutput::default();
    let result = template.render_captured_to(
        minijinja::value::Serde(template_context(context)),
        &mut output,
    );
    if output.exceeded {
        return Err("Rendered webhook exceeds the 256 KiB limit.".into());
    }
    result.map_err(template_error)?;
    let payload: Value = serde_json::from_slice(&output.bytes).map_err(|error| {
        format!(
            "Rendered webhook is not valid JSON at line {}, column {}. Use tojson for dynamic values.",
            error.line(),
            error.column()
        )
    })?;
    if !payload.is_object() {
        return Err("Rendered webhook must be a JSON object.".into());
    }
    Ok(payload)
}

// MiniJinja's built-in tojson serializes undefined values as null even in
// strict mode. Reject them, including inside arrays and objects, before encoding.
fn strict_tojson(
    value: &minijinja::Value,
    indent: Option<minijinja::Value>,
    args: Kwargs,
) -> Result<minijinja::Value, Error> {
    fn checked_value(
        value: &minijinja::Value,
        depth: usize,
        remaining: &mut usize,
    ) -> Result<minijinja::Value, Error> {
        if value.is_undefined() {
            return Err(Error::from(ErrorKind::UndefinedError));
        }
        if depth == 0 || *remaining == 0 {
            return Err(Error::new(
                ErrorKind::InvalidOperation,
                "JSON value limit exceeded",
            ));
        }
        *remaining -= 1;
        match value.kind() {
            ValueKind::Map => {
                let mut pairs = Vec::new();
                for key in value.try_iter()? {
                    let item = checked_value(&value.get_item(&key)?, depth - 1, remaining)?;
                    pairs.push((checked_value(&key, depth - 1, remaining)?, item));
                }
                Ok(minijinja::Value::from_pairs(pairs))
            }
            ValueKind::Seq | ValueKind::Iterable => {
                let mut items = Vec::new();
                for item in value.try_iter()? {
                    items.push(checked_value(&item, depth - 1, remaining)?);
                }
                // Materialize iterators once so validation does not consume the
                // values that tojson will serialize (e.g. select/map filters).
                Ok(minijinja::Value::from(items))
            }
            _ => Ok(value.clone()),
        }
    }
    let value = checked_value(value, 64, &mut 50_000)?;
    minijinja::filters::tojson(&value, indent, args)
}

// Missing fields vary between notification and authentication events. Keep them
// empty so one template can use `if reason` or `if worldName` for either event.
fn template_context(context: &Value) -> Value {
    let mut context = context.clone();
    for name in TEMPLATE_VARIABLES.iter() {
        let mut value = &mut context;
        for key in name.split('.') {
            if !value.is_object() {
                *value = Value::Object(Default::default());
            }
            value = value
                .as_object_mut()
                .unwrap()
                .entry(key)
                .or_insert(Value::Null);
        }
        if value.is_null() {
            *value = Value::String(String::new());
        }
    }
    context
}

fn template_error(error: minijinja::Error) -> String {
    // Error details/debug output can contain template text or event data.
    format!(
        "Invalid webhook template: {} at line {}.",
        error.kind(),
        error.line().unwrap_or(1)
    )
}

#[derive(Default)]
struct BoundedOutput {
    bytes: Vec<u8>,
    exceeded: bool,
}

impl io::Write for BoundedOutput {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.len() > MAX_OUTPUT_BYTES - self.bytes.len() {
            self.exceeded = true;
            return Err(io::Error::other("Webhook output limit exceeded"));
        }
        self.bytes.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn renders_nested_values_without_reinterpreting_or_breaking_json() {
        let message = "你好 \"quoted\"\n\\ {{unknown}} <&>";
        let context = json!({"title": "Hello", "message": message, "user": {"displayName": "Pizza"}, "version": 1});
        let payload = render_custom_webhook(r#"{"text":{"content":{{ (title ~ ': ' ~ message) | tojson }}},"items":[{{ (user.displayName ~ '/' ~ user.displayName) | tojson }},true,42,null,{{ version | tojson }}]}"#, &context).unwrap();
        assert_eq!(payload["text"]["content"], format!("Hello: {message}"));
        assert_eq!(payload["items"], json!(["Pizza/Pizza", true, 42, null, 1]));
    }

    #[test]
    fn supports_conditions_loops_filters_and_native_json_types() {
        let template = r#"{"items":[{% for value in [title, worldName, reason] if value %}{{ value | upper | tojson }}{% if not loop.last %},{% endif %}{% endfor %}]{% if reason %},"auth":true{% endif %},"user":{{ user | tojson }}}"#;
        let notification = render_custom_webhook(
            template,
            &json!({"title":"Hello", "worldName":"World", "user":{"id":"123"}}),
        )
        .unwrap();
        assert_eq!(
            notification,
            json!({"items":["HELLO","WORLD"],"user":{"id":"123","displayName":""}})
        );
        let auth =
            render_custom_webhook(template, &json!({"title":"Auth", "reason":"Expired"})).unwrap();
        assert_eq!(auth["items"], json!(["AUTH", "EXPIRED"]));
        assert_eq!(auth["auth"], true);
    }

    #[test]
    fn serializes_filtered_iterators_and_explicit_defaults() {
        assert_eq!(
            render_custom_webhook(
                r#"{"items":{{ [1, 2, 3] | select('odd') | tojson(indent=2) }},"fallback":{{ unknown | default('fallback') | tojson }}}"#,
                &json!({})
            ).unwrap(),
            json!({"items":[1, 3],"fallback":"fallback"})
        );
    }

    #[test]
    fn missing_known_fields_are_empty() {
        assert_eq!(
            render_custom_webhook(
                r#"{"text":{{ (worldName ~ '|' ~ reason ~ '|' ~ user.id) | tojson }}}"#,
                &json!({"user":null})
            )
            .unwrap(),
            json!({"text": "||"})
        );
    }

    #[test]
    fn rejects_invalid_templates_without_echoing_their_contents() {
        for template in [
            "",
            "{secret",
            "[]",
            "null",
            "42",
            r#"{"x":{{ secret | tojson }}}"#,
            r#"{"x":{{ [secret] | tojson }}}"#,
            r#"{"x":{{ {'nested': secret} | tojson }}}"#,
            r#"{"x":"{{title"}"#,
            "{% if secret %}{}{% endif %}",
            "{% include 'secret' %}",
            "{{ 'secret' | unknown_filter }}",
        ] {
            let error = render_custom_webhook(template, &json!({})).unwrap_err();
            assert!(!error.contains("secret"), "{error}");
        }
        // There is no old-engine fallback: quoted placeholders do not escape JSON.
        let error =
            render_custom_webhook(r#"{"x":"{{message}}"}"#, &json!({"message":"\"secret\""}))
                .unwrap_err();
        assert!(error.contains("tojson"));
        assert!(!error.contains("secret"));
    }

    #[test]
    fn limits_template_output_and_execution() {
        assert!(
            render_custom_webhook(&" ".repeat(MAX_TEMPLATE_BYTES + 1), &json!({}))
                .unwrap_err()
                .contains("64 KiB")
        );
        assert!(render_custom_webhook(
            "{{ message | tojson }}",
            &json!({"message":"x".repeat(MAX_OUTPUT_BYTES)})
        )
        .unwrap_err()
        .contains("256 KiB"));
        assert!(render_custom_webhook(
            "{% for i in range(100000) %}{% set x = i %}{% endfor %}{}",
            &json!({})
        )
        .unwrap_err()
        .contains("fuel"));
        assert!(render_custom_webhook(
            "{% macro recur() %}{{ recur() }}{% endmacro %}{{ recur() }}",
            &json!({})
        )
        .is_err());
    }

    #[test]
    fn default_template_and_variable_catalog_are_valid() {
        assert_eq!(
            render_custom_webhook(
                DEFAULT_WEBHOOK_TEMPLATE,
                &json!({"title":"Test","message":"Body"})
            )
            .unwrap(),
            json!({"title":"Test","message":"Body"})
        );
        for name in TEMPLATE_VARIABLES.iter() {
            let template = format!("{{\"value\":{{{{ {name} | tojson }}}}}}");
            assert_eq!(
                render_custom_webhook(&template, &json!({})).unwrap(),
                json!({"value":""})
            );
        }
    }
}
