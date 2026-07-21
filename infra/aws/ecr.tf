# Release repositories are intentionally shared by staging and production.
# Both environments deploy the exact same digest from one CI release manifest.
data "aws_ecr_repository" "service" {
  for_each = local.services

  name = local.ecr_repository_names[each.key]
}

# Fail planning if a requested release digest was not published to the exact
# shared AlphaNet repository first. A syntactically valid but absent digest is
# not an acceptable bootstrap placeholder, even while desired_count is zero.
data "aws_ecr_image" "service" {
  for_each = local.services

  repository_name = data.aws_ecr_repository.service[each.key].name
  image_digest    = split("@", var.image_overrides[each.key])[1]
}
