import type { PrismaClient } from "@prisma/client";

const categories = [
  { name: "Trending", slug: "trending" },
  { name: "Fitness", slug: "fitness" },
  { name: "Cooking", slug: "cooking" },
  { name: "Design", slug: "design" },
  { name: "Coding", slug: "coding" },
  { name: "Language", slug: "language" },
  { name: "Business", slug: "business" },
  { name: "Finance", slug: "finance" },
  { name: "Communication", slug: "communication" },
  { name: "Music", slug: "music" },
];

const tags = [
  { name: "Beginner", slug: "beginner" },
  { name: "Intermediate", slug: "intermediate" },
  { name: "Advanced", slug: "advanced" },
  { name: "Quick tip", slug: "quick-tip" },
  { name: "Tutorial", slug: "tutorial" },
  { name: "Challenge", slug: "challenge" },
];

export async function seedReferenceData(prisma: PrismaClient): Promise<void> {
  const roles = [
    { code: "USER", name: "User" },
    { code: "CREATOR", name: "Creator" },
    { code: "ADMIN", name: "Admin" },
  ];
  for (const role of roles) {
    await prisma.role.upsert({
      where: { code: role.code },
      update: { name: role.name },
      create: role,
    });
  }
  for (const category of categories) {
    await prisma.category.upsert({
      where: { slug: category.slug },
      update: { name: category.name, isActive: true },
      create: { name: category.name, slug: category.slug, isActive: true },
    });
  }
  for (const tag of tags) {
    await prisma.tag.upsert({
      where: { slug: tag.slug },
      update: { name: tag.name },
      create: { name: tag.name, slug: tag.slug },
    });
  }
}
