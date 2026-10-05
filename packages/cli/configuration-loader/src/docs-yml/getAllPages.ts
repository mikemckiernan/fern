import { docsYml } from "@fern-api/configuration";
import { assertNever } from "@fern-api/core-utils";
import { AbsoluteFilePath, RelativeFilePath, relativize } from "@fern-api/fs-utils";
import { readFile } from "fs/promises";
import { compact } from "lodash-es";

const BATCH_SIZE = 100; // Define a reasonable batch size

/** Post-processes the content of a page as it is loaded. */
export type TransformPageContent = (file: AbsoluteFilePath, content: string) => string;

interface LoadPagesOptions {
    files: AbsoluteFilePath[];
    absolutePathToFernFolder: AbsoluteFilePath;
    transformContent: TransformPageContent | undefined;
}

async function loadBatch({
    files,
    absolutePathToFernFolder,
    transformContent
}: LoadPagesOptions): Promise<Record<RelativeFilePath, string>> {
    const pairs = await Promise.all(
        files.map(async (file) => {
            const content = await readFile(file, "utf-8");
            return [relativize(absolutePathToFernFolder, file), transformContent?.(file, content) ?? content];
        })
    );
    return Object.fromEntries(pairs);
}

export async function loadAllPages({
    files,
    absolutePathToFernFolder,
    transformContent
}: {
    files: AbsoluteFilePath[];
    absolutePathToFernFolder: AbsoluteFilePath;
    transformContent?: TransformPageContent;
}): Promise<Record<RelativeFilePath, string>> {
    const result: Record<RelativeFilePath, string> = {};

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);
        const batchResult = await loadBatch({
            files: batch,
            absolutePathToFernFolder,
            transformContent
        });
        Object.assign(result, batchResult);
    }

    return result;
}

export function getAllPages({
    landingPage,
    navigation
}: {
    landingPage: docsYml.DocsNavigationItem.Page | undefined;
    navigation: docsYml.DocsNavigationConfiguration;
}): AbsoluteFilePath[] {
    return compact([landingPage?.absolutePath, ...getAllPagesFromNavigationConfig(navigation)]);
}

/**
 * Looks up the substituter that applies to a page. Pages outside any version, and content
 * with no page of its own (`file` undefined), get the site's substituter.
 */
export type GetPageSubstituter = (file?: AbsoluteFilePath) => docsYml.PageSubstituter;

/**
 * Builds one {@link docsYml.PageSubstituter} per version and per product (plus one for pages
 * outside both) and returns a lookup from page path to the substituter that applies to it.
 *
 * A page listed in more than one product uses the substitutions of the last of those products
 * in docs.yml; `onSharedPage` receives a message for each such page.
 */
export function createPageSubstituters({
    navigation,
    siteConfig,
    context,
    preview,
    onSharedPage
}: {
    navigation: docsYml.DocsNavigationConfiguration;
    siteConfig: docsYml.DocsSubstitutionConfig;
    context: docsYml.DocsSubstitutionContext;
    preview: boolean;
    onSharedPage?: (message: string) => void;
}): GetPageSubstituter {
    const siteSubstituter = docsYml.createPageSubstituter(undefined, siteConfig, context, { preview });
    const byPage = new Map<AbsoluteFilePath, { substituter: docsYml.PageSubstituter; product: string | undefined }>();
    const setSubstituter = (
        pages: AbsoluteFilePath[],
        substituter: docsYml.PageSubstituter,
        product: string | undefined
    ) => {
        for (const page of pages) {
            const previous = byPage.get(page)?.product;
            if (previous != null && product != null && previous !== product) {
                onSharedPage?.(
                    `${page} is a page in products ${previous} and ${product}. ` +
                        `The page uses the substitutions of ${product}.`
                );
            }
            byPage.set(page, { substituter, product });
        }
    };
    const setVersionSubstituters = (versions: docsYml.VersionInfo[], product: string | undefined) => {
        for (const version of versions) {
            setSubstituter(
                getAllPages({ landingPage: version.landingPage, navigation: version.navigation }),
                docsYml.createPageSubstituter(version.substitutions, siteConfig, context, { preview }),
                product
            );
        }
    };
    switch (navigation.type) {
        case "tabbed":
        case "untabbed":
            break;
        case "versioned":
            setVersionSubstituters(navigation.versions, undefined);
            break;
        case "productgroup":
            for (const product of navigation.products) {
                if (product.type === "external") {
                    continue;
                }
                const productSubstituter = docsYml.createProductPageSubstituter(
                    product.substitutions,
                    siteConfig,
                    context,
                    { preview }
                );
                if (product.navigation.type === "versioned") {
                    setSubstituter(compact([product.landingPage?.absolutePath]), productSubstituter, product.product);
                    setVersionSubstituters(product.navigation.versions, product.product);
                } else {
                    setSubstituter(
                        getAllPages({ landingPage: product.landingPage, navigation: product.navigation }),
                        productSubstituter,
                        product.product
                    );
                }
            }
            break;
        default:
            assertNever(navigation);
    }
    return (file) => (file != null ? byPage.get(file)?.substituter : undefined) ?? siteSubstituter;
}

function getAllPagesFromNavigationConfig(navigation: docsYml.DocsNavigationConfiguration): AbsoluteFilePath[] {
    switch (navigation.type) {
        case "tabbed":
            return navigation.items.flatMap((tab) => {
                if (tab.child.type === "layout") {
                    return tab.child.layout.flatMap((item) => {
                        return getAllPagesFromNavigationItem({
                            item
                        });
                    });
                } else if (tab.child.type === "variants") {
                    return tab.child.variants.flatMap((variant) =>
                        variant.layout.flatMap((item) => {
                            return getAllPagesFromNavigationItem({
                                item
                            });
                        })
                    );
                } else if (tab.child.type === "changelog") {
                    return tab.child.changelog;
                }
                return [];
            });
        case "untabbed":
            return navigation.items.flatMap((item) => {
                return getAllPagesFromNavigationItem({
                    item
                });
            });
        case "versioned":
            return navigation.versions.flatMap((version) => {
                return getAllPages({
                    landingPage: version.landingPage,
                    navigation: version.navigation
                });
            });
        case "productgroup":
            return [
                ...navigation.products.flatMap((product) => {
                    if (product.type === "external") {
                        return [];
                    }

                    return getAllPages({
                        landingPage: product.landingPage,
                        navigation: product.navigation
                    });
                }),
                ...(navigation.changelog != null ? getAllPagesFromNavigationItem({ item: navigation.changelog }) : [])
            ];
        default:
            assertNever(navigation);
    }
}

export function getAllPagesFromNavigationItem({ item }: { item: docsYml.DocsNavigationItem }): AbsoluteFilePath[] {
    switch (item.type) {
        case "apiSection":
            return compact([
                item.overviewAbsolutePath,
                ...item.navigation.flatMap((apiNavigation) =>
                    getAllPagesFromApiReferenceLayoutItem({ item: apiNavigation })
                )
            ]);
        case "link":
            return [];
        case "page":
            return [item.absolutePath];
        case "section":
            return compact([
                item.overviewAbsolutePath,
                ...item.contents.flatMap((subItem) => {
                    return getAllPagesFromNavigationItem({ item: subItem });
                })
            ]);
        case "changelog":
            return item.changelog;
        case "librarySection":
            // Library docs pages are generated locally, but referenced via _navigation.yml
            return [];
        default:
            assertNever(item);
    }
}

function getAllPagesFromApiReferenceLayoutItem({
    item
}: {
    item: docsYml.ParsedApiReferenceLayoutItem;
}): AbsoluteFilePath[] {
    if (item.type === "page") {
        return [item.absolutePath];
    } else if (item.type === "package" || item.type === "section") {
        return compact([
            item.overviewAbsolutePath,
            ...item.contents.flatMap((subItem) => {
                return getAllPagesFromApiReferenceLayoutItem({ item: subItem });
            })
        ]);
    }
    return [];
}
